// 待办候选仓储：支持一条候选关联多条来源消息；接受时把所有来源挂到同一个 todo。
// 文档链接不走这里，由 classify worker 直接派生填写任务。
function createSuggestionRepository(db){
  const jsonText=value=>value===undefined||value===null?null:(typeof value==='string'?value:JSON.stringify(value));
  const joined=(id,accountRef)=>db.prepare(`SELECT s.*,m.account_ref,m.sender_id,m.conversation_type,
      m.conversation_id,m.content_text,m.link_json,m.received_at
    FROM suggestions s JOIN messages m ON m.id=s.message_id
    WHERE s.id=? AND m.account_ref=?`).get(Number(id),String(accountRef))||null;
  const sourceIds=suggestionId=>db.prepare('SELECT message_id FROM suggestion_messages WHERE suggestion_id=? ORDER BY message_id')
    .all(Number(suggestionId)).map(row=>row.message_id);

  return {
    insert(suggestion){
      const createdAt=suggestion.createdAt||new Date().toISOString();
      const messageId=Number(suggestion.messageId);
      const messageIds=[...new Set([messageId,...(suggestion.messageIds||[]).map(Number).filter(Number.isInteger)])];
      db.exec('BEGIN IMMEDIATE');
      try{
        const info=db.prepare(`INSERT INTO suggestions
          (message_id,message_version,kind,title,summary,category,confidence,action_json,status,rationale,model,created_at,
           account_ref,conversation_type,conversation_id,thread_key,source_count,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(messageId,suggestion.messageVersion||1,suggestion.kind||'todo',
            String(suggestion.title||'待办'),suggestion.summary||null,suggestion.category||null,
            suggestion.confidence??null,jsonText(suggestion.actionJson),suggestion.status||'pending',
            suggestion.rationale||null,suggestion.model||null,createdAt,
            suggestion.accountRef||null,suggestion.conversationType||null,suggestion.conversationId||null,
            suggestion.threadKey||null,messageIds.length,createdAt);
        const id=Number(info.lastInsertRowid);
        for(const sourceId of messageIds){
          db.prepare('INSERT OR IGNORE INTO suggestion_messages(suggestion_id,message_id,created_at) VALUES(?,?,?)')
            .run(id,sourceId,createdAt);
        }
        db.exec('COMMIT');
        return id;
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
    },
    updateMerged({id,accountRef,title,summary,category,confidence,rationale,messageIds=[],updatedAt=new Date().toISOString()}){
      const row=joined(id,accountRef);
      if(!row)throw Error('suggestion_not_found');
      if(row.status!=='pending')throw Error('suggestion_already_decided');
      db.exec('BEGIN IMMEDIATE');
      try{
        for(const messageId of messageIds){
          db.prepare('INSERT OR IGNORE INTO suggestion_messages(suggestion_id,message_id,created_at) VALUES(?,?,?)')
            .run(Number(id),Number(messageId),updatedAt);
        }
        const count=sourceIds(id).length;
        db.prepare(`UPDATE suggestions SET title=?,summary=?,category=?,confidence=?,rationale=?,
          source_count=?,updated_at=? WHERE id=? AND status='pending'`)
          .run(String(title||row.title),summary??row.summary,category||row.category,
            confidence??row.confidence,rationale??row.rationale,count,updatedAt,Number(id));
        db.exec('COMMIT');
        return joined(id,accountRef);
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
    },
    list({accountRef,status='pending',limit=50}){
      const safeLimit=Math.min(Math.max(Number(limit)||50,1),100);
      return db.prepare(`SELECT s.*,m.sender_id,m.conversation_type,m.conversation_id,
          m.content_text,m.link_json,m.received_at
        FROM suggestions s JOIN messages m ON m.id=s.message_id
        WHERE m.account_ref=? AND s.status=?
        ORDER BY s.updated_at DESC,s.created_at DESC,s.id DESC LIMIT ?`)
        .all(String(accountRef),String(status),safeLimit);
    },
    get({id,accountRef}){return joined(id,accountRef);},
    pendingForConversation({accountRef,conversationType,conversationId,limit=20}){
      return db.prepare(`SELECT s.* FROM suggestions s
        WHERE s.account_ref=? AND s.conversation_type=? AND s.conversation_id=? AND s.status='pending'
        ORDER BY s.updated_at DESC,s.id DESC LIMIT ?`)
        .all(String(accountRef),String(conversationType),String(conversationId),
          Math.min(Math.max(Number(limit)||20,1),50));
    },
    listForMessage({messageId,accountRef}){
      return db.prepare(`SELECT s.* FROM suggestions s
        JOIN suggestion_messages sm ON sm.suggestion_id=s.id
        JOIN messages m ON m.id=s.message_id
        WHERE sm.message_id=? AND m.account_ref=? ORDER BY s.id DESC`)
        .all(Number(messageId),String(accountRef));
    },
    sources({suggestionId,accountRef}){
      return db.prepare(`SELECT m.id,m.sender_id,m.received_at,m.content_text
        FROM suggestion_messages sm
        JOIN messages m ON m.id=sm.message_id
        WHERE sm.suggestion_id=? AND m.account_ref=?
        ORDER BY m.id`).all(Number(suggestionId),String(accountRef));
    },
    accept({id,accountRef,deviceId=null,createdAt=new Date().toISOString()}){
      const ownTransaction=!db.isTransaction;
      if(ownTransaction)db.exec('BEGIN IMMEDIATE');
      try{
        const row=joined(id,accountRef);
        if(!row)throw Error('suggestion_not_found');
        if(row.status!=='pending')throw Error('suggestion_already_decided');
        const created=db.prepare("INSERT INTO todos(title,status,priority,created_at,updated_at) VALUES(?,'open',0,?,?)")
          .run(row.title||'待办',createdAt,createdAt);
        const todoId=Number(created.lastInsertRowid);
        const messageIds=sourceIds(id);
        for(const messageId of (messageIds.length?messageIds:[row.message_id])){
          db.prepare('INSERT OR IGNORE INTO todo_messages(todo_id,message_id,created_at) VALUES(?,?,?)')
            .run(todoId,messageId,createdAt);
        }
        db.prepare("UPDATE suggestions SET status='accepted',decided_at=?,decided_device_id=? WHERE id=?")
          .run(createdAt,deviceId,Number(id));
        if(ownTransaction)db.exec('COMMIT');
        return {
          suggestion:joined(id,accountRef),
          todo:db.prepare('SELECT * FROM todos WHERE id=?').get(todoId)
        };
      }catch(error){
        if(ownTransaction)db.exec('ROLLBACK');
        throw error;
      }
    },
    dismiss({id,accountRef,deviceId=null,createdAt=new Date().toISOString()}){
      const row=joined(id,accountRef);
      if(!row)throw Error('suggestion_not_found');
      if(row.status!=='pending')throw Error('suggestion_already_decided');
      const updated=db.prepare("UPDATE suggestions SET status='dismissed',decided_at=?,decided_device_id=? WHERE id=? AND status='pending'")
        .run(createdAt,deviceId,Number(id));
      if(updated.changes!==1)throw Error('suggestion_already_decided');
      return joined(id,accountRef);
    },
    listTodos({accountRef,status=null,limit=100}){
      const safeLimit=Math.min(Math.max(Number(limit)||100,1),200);
      const params=[String(accountRef)];
      let where="m.account_ref=? AND t.status<>'deleted'";
      if(status){where+=' AND t.status=?';params.push(String(status));}
      return db.prepare(`SELECT DISTINCT t.* FROM todos t
        JOIN todo_messages tm ON tm.todo_id=t.id
        JOIN messages m ON m.id=tm.message_id
        WHERE ${where} ORDER BY t.created_at DESC,t.id DESC LIMIT ?`)
        .all(...params,safeLimit);
    },
    updateTodo({id,accountRef,action,now=new Date().toISOString()}){
      if(!['complete','reopen','delete'].includes(action))throw Error('invalid_body');
      const status={complete:'done',reopen:'open',delete:'deleted'}[action];
      if(!status)throw Error('invalid_body');
      // Soft deletion keeps original messages and document operations intact.
      // Require ownership of every source message, not just one matching link.
      const result=db.prepare(`UPDATE todos SET status=?,updated_at=? WHERE id=?
        AND (status IN ('open','done') OR (status='deleted' AND ?='delete'))
        AND EXISTS(SELECT 1 FROM todo_messages tm JOIN messages m ON m.id=tm.message_id WHERE tm.todo_id=todos.id AND m.account_ref=?)
        AND NOT EXISTS(SELECT 1 FROM todo_messages tm JOIN messages m ON m.id=tm.message_id WHERE tm.todo_id=todos.id AND m.account_ref<>?)`)
        .run(status,now,Number(id),action,String(accountRef),String(accountRef));
      if(result.changes!==1)throw Error('todo_not_found');
      return db.prepare('SELECT * FROM todos WHERE id=?').get(Number(id));
    }
  };
}

module.exports={createSuggestionRepository};
