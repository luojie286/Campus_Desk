// 消息仓储：按账号隔离、按源消息去重、keyset 分页，并通过 message_versions 保留原文。
function createMessageRepository(db){
  const jsonText=value=>value===undefined||value===null?null:(typeof value==='string'?value:JSON.stringify(value));
  return {
    insertInbound({adapterInstance,eventId,eventType='message',receivedAt,rawSha256=null}){
      const result=db.prepare(`INSERT OR IGNORE INTO inbound_events
        (adapter_instance,event_id,event_type,received_at,raw_sha256,status)
        VALUES(?,?,?,?,?,'stored')`)
        .run(String(adapterInstance),String(eventId),String(eventType),receivedAt,rawSha256);
      return result.changes===1;
    },
    insert(message){
      const receivedAt=message.receivedAt||new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try{
        const result=db.prepare(`INSERT OR IGNORE INTO messages
          (platform,adapter_instance,account_ref,conversation_type,conversation_id,sender_id,
           source_message_id,source_time,received_at,kind,content_text,content_json,link_json,
           completeness,identity_quality,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(message.platform,message.adapterInstance,message.accountRef,message.conversationType,
            message.conversationId,message.senderId,message.sourceMessageId,message.sourceTime||null,
            receivedAt,message.kind||'text',message.contentText||null,jsonText(message.contentJson),
            jsonText(message.linkJson),message.completeness||null,message.identityQuality||null,
            receivedAt,receivedAt);
        let id;
        if(result.changes===1){
          id=Number(result.lastInsertRowid);
          db.prepare(`INSERT OR IGNORE INTO message_versions
            (message_id,version,content_text,content_json,raw_json,source_time,created_at)
            VALUES(?,1,?,?,?,?,?)`)
            .run(id,message.contentText||null,jsonText(message.contentJson),jsonText(message.rawJson),
              message.sourceTime||null,receivedAt);
        }else{
          const existing=db.prepare(`SELECT id FROM messages
            WHERE platform=? AND account_ref=? AND conversation_type=? AND conversation_id=? AND source_message_id=?`)
            .get(message.platform,message.accountRef,message.conversationType,message.conversationId,message.sourceMessageId);
          id=existing.id;
        }
        db.exec('COMMIT');
        return {id,inserted:result.changes===1};
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
    },
    list({accountRef,cursor=null,limit=30,senderId=null,conversationId=null,unreadOnly=false}){
      const safeLimit=Math.min(Math.max(Number(limit)||30,1),100);
      const params=[String(accountRef)];
      let where='account_ref=?';
      if(senderId){where+=' AND sender_id=?';params.push(String(senderId));}
      if(conversationId){where+=' AND conversation_id=?';params.push(String(conversationId));}
      if(unreadOnly)where+=' AND read_at IS NULL';
      if(cursor){
        let decoded;
        try{decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}
        catch{throw Error('invalid_cursor');}
        if(!decoded||typeof decoded.t!=='string'||!Number.isInteger(decoded.id))throw Error('invalid_cursor');
        where+=' AND (received_at<? OR (received_at=? AND id<?))';
        params.push(decoded.t,decoded.t,decoded.id);
      }
      const rows=db.prepare(`SELECT * FROM messages WHERE ${where} ORDER BY received_at DESC,id DESC LIMIT ?`)
        .all(...params,safeLimit+1);
      const hasMore=rows.length>safeLimit;
      const items=rows.slice(0,safeLimit);
      const last=items[items.length-1];
      return {
        items,
        hasMore,
        nextCursor:hasMore&&last
          ? Buffer.from(JSON.stringify({t:last.received_at,id:last.id})).toString('base64url')
          : null
      };
    },
    get({id,accountRef}){
      return db.prepare('SELECT * FROM messages WHERE id=? AND account_ref=?')
        .get(Number(id),String(accountRef))||null;
    },
    markRead({id,accountRef,readAt=new Date().toISOString()}){
      return db.prepare('UPDATE messages SET read_at=?,updated_at=? WHERE id=? AND account_ref=?')
        .run(readAt,readAt,Number(id),String(accountRef)).changes===1;
    }
  };
}

module.exports={createMessageRepository};
