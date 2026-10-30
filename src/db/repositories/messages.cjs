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
    // 左侧来源列表：按会话聚合未读数和最后一条消息，不返回 raw_json。
    sources({accountRef}){
      return db.prepare(`SELECT m.conversation_type,m.conversation_id,COUNT(*) AS total,
        SUM(CASE WHEN m.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
        MAX(m.received_at) AS last_at,
        (SELECT x.sender_id FROM messages x
          WHERE x.account_ref=m.account_ref AND x.conversation_type=m.conversation_type AND x.conversation_id=m.conversation_id
          ORDER BY x.received_at DESC,x.id DESC LIMIT 1) AS last_sender_id,
        (SELECT x.content_text FROM messages x
          WHERE x.account_ref=m.account_ref AND x.conversation_type=m.conversation_type AND x.conversation_id=m.conversation_id
          ORDER BY x.received_at DESC,x.id DESC LIMIT 1) AS last_text
        FROM messages m WHERE m.account_ref=?
        GROUP BY m.conversation_type,m.conversation_id
        ORDER BY last_at DESC`)
        .all(String(accountRef));
    },
    markRead({id,accountRef,readAt=new Date().toISOString()}){
      return db.prepare('UPDATE messages SET read_at=?,updated_at=? WHERE id=? AND account_ref=?')
        .run(readAt,readAt,Number(id),String(accountRef)).changes===1;
    },
    conversationCursor({accountRef,conversationType,conversationId}){
      return db.prepare(`SELECT * FROM conversation_cursors
        WHERE account_ref=? AND conversation_type=? AND conversation_id=?`)
        .get(String(accountRef),String(conversationType),String(conversationId))||null;
    },
    setConversationCursor({accountRef,conversationType,conversationId,lastMessageId,now=new Date().toISOString()}){
      db.prepare(`INSERT INTO conversation_cursors
        (account_ref,conversation_type,conversation_id,last_message_id,updated_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(account_ref,conversation_type,conversation_id)
        DO UPDATE SET last_message_id=excluded.last_message_id,updated_at=excluded.updated_at`)
        .run(String(accountRef),String(conversationType),String(conversationId),Number(lastMessageId),now);
      return db.prepare(`SELECT * FROM conversation_cursors
        WHERE account_ref=? AND conversation_type=? AND conversation_id=?`)
        .get(String(accountRef),String(conversationType),String(conversationId));
    },
    messagesAfter({accountRef,conversationType,conversationId,afterId=0,limit=20}){
      const safeLimit=Math.min(Math.max(Number(limit)||20,1),50);
      return db.prepare(`SELECT * FROM messages
        WHERE account_ref=? AND conversation_type=? AND conversation_id=? AND id>?
        ORDER BY id ASC LIMIT ?`)
        .all(String(accountRef),String(conversationType),String(conversationId),Number(afterId),safeLimit);
    }
  };
}

module.exports={createMessageRepository};
