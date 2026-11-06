// 监听来源：群/私聊 + 可选发送者。运行时按稳定 ID 过滤，display_name 只用于展示。
function createSourceRepository(db){
  const nowIso=()=>new Date().toISOString();
  const rowSource=row=>row?{
    type:row.conversation_type,
    id:String(row.conversation_id),
    sender_id:row.sender_id||'',
    account_id:String(row.account_ref),
    display_name:row.display_name||null
  }:null;
  return {
    list({accountRef,enabledOnly=false}={}){
      let where='account_ref=?';const params=[String(accountRef)];
      if(enabledOnly){where+=' AND enabled=1';}
      return db.prepare(`SELECT * FROM sources WHERE ${where} ORDER BY created_at DESC,id DESC`)
        .all(...params);
    },
    get({id,accountRef}){
      return db.prepare('SELECT * FROM sources WHERE id=? AND account_ref=?').get(Number(id),String(accountRef))||null;
    },
    add({accountRef,platform='qq',adapterInstance='onebot-main',conversationType,conversationId,senderId='',displayName=null,now=nowIso()}){
      if(!['group','private'].includes(conversationType))throw Error('source_type_invalid');
      if(!/^\d+$/.test(String(conversationId||'')))throw Error('source_id_invalid');
      if(senderId&&!/^\d+$/.test(String(senderId)))throw Error('source_sender_invalid');
      const info=db.prepare(`INSERT INTO sources
        (platform,account_ref,adapter_instance,conversation_type,conversation_id,sender_id,display_name,enabled,auto_prepare,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,1,0,?,?)
        ON CONFLICT(platform,account_ref,conversation_type,conversation_id,sender_id)
        DO UPDATE SET display_name=excluded.display_name,enabled=1,updated_at=excluded.updated_at`)
        .run(String(platform),String(accountRef),String(adapterInstance),String(conversationType),
          String(conversationId),String(senderId||''),displayName===null?null:String(displayName),now,now);
      const row=db.prepare(`SELECT * FROM sources WHERE platform=? AND account_ref=?
        AND conversation_type=? AND conversation_id=? AND sender_id=?`)
        .get(String(platform),String(accountRef),String(conversationType),String(conversationId),String(senderId||''));
      return {...row,created:info.changes===1};
    },
    remove({id,accountRef}){
      return db.prepare('DELETE FROM sources WHERE id=? AND account_ref=?')
        .run(Number(id),String(accountRef)).changes===1;
    },
    setEnabled({id,accountRef,enabled,now=nowIso()}){
      return db.prepare('UPDATE sources SET enabled=?,updated_at=? WHERE id=? AND account_ref=?')
        .run(enabled?1:0,now,Number(id),String(accountRef)).changes===1;
    },
    updateDisplayName({id,accountRef,displayName,now=nowIso()}){
      return db.prepare('UPDATE sources SET display_name=?,updated_at=? WHERE id=? AND account_ref=?')
        .run(displayName===null?null:String(displayName),now,Number(id),String(accountRef)).changes===1;
    },
    matchEvent(event,{accountRef}){
      if(event.post_type!=='message')return null;
      if(String(event.self_id)!==String(accountRef))return null;
      const rows=db.prepare("SELECT * FROM sources WHERE account_ref=? AND platform='qq' AND enabled=1 ORDER BY created_at DESC,id DESC")
        .all(String(accountRef));
      return rows.find(row=>{
        if(row.conversation_type==='private'){
          return event.message_type==='private'&&String(event.user_id)===String(row.conversation_id);
        }
        return event.message_type==='group'&&String(event.group_id)===String(row.conversation_id)
          &&(!row.sender_id||String(event.user_id)===String(row.sender_id));
      })||null;
    },
    seedFromConfig({accountRef,source,displayName=null,now=nowIso()}){
      if(!source||!source.id)return null;
      return this.add({
        accountRef,
        conversationType:source.type,
        conversationId:source.id,
        senderId:source.sender_id||'',
        // config.source_name 是发送者昵称，不是群名；群名必须等 OneBot 联系人刷新。
        displayName:source.type==='private'?(displayName||null):null,
        now
      });
    },
    toLegacySource(row){return rowSource(row);}
  };
}

module.exports={createSourceRepository};
