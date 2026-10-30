// 待办候选仓储：只处理聊天/文件总结形成的待办；接受时创建正式待办，忽略时只改状态。
// 文档链接不走这里，由 classify worker 直接派生填写任务。
function createSuggestionRepository(db){
  const jsonText=value=>value===undefined||value===null?null:(typeof value==='string'?value:JSON.stringify(value));
  const joined=(id,accountRef)=>db.prepare(`SELECT s.*,m.account_ref,m.sender_id,m.conversation_type,
      m.conversation_id,m.content_text,m.link_json,m.received_at
    FROM suggestions s JOIN messages m ON m.id=s.message_id
    WHERE s.id=? AND m.account_ref=?`).get(Number(id),String(accountRef))||null;
  return {
    insert(suggestion){
      const info=db.prepare(`INSERT INTO suggestions
        (message_id,message_version,kind,title,summary,category,confidence,action_json,status,rationale,model,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(Number(suggestion.messageId),suggestion.messageVersion||1,suggestion.kind||'todo',
          String(suggestion.title||'待办'),suggestion.summary||null,suggestion.category||null,
          suggestion.confidence??null,jsonText(suggestion.actionJson),suggestion.status||'pending',
          suggestion.rationale||null,suggestion.model||null,
          suggestion.createdAt||new Date().toISOString());
      return Number(info.lastInsertRowid);
    },
    list({accountRef,status='pending',limit=50}){
      const safeLimit=Math.min(Math.max(Number(limit)||50,1),100);
      return db.prepare(`SELECT s.*,m.sender_id,m.conversation_type,m.conversation_id,
          m.content_text,m.link_json,m.received_at
        FROM suggestions s JOIN messages m ON m.id=s.message_id
        WHERE m.account_ref=? AND s.status=?
        ORDER BY s.created_at DESC,s.id DESC LIMIT ?`)
        .all(String(accountRef),String(status),safeLimit);
    },
    get({id,accountRef}){return joined(id,accountRef);},
    listForMessage({messageId,accountRef}){
      return db.prepare(`SELECT s.* FROM suggestions s
        JOIN messages m ON m.id=s.message_id
        WHERE s.message_id=? AND m.account_ref=? ORDER BY s.id DESC`)
        .all(Number(messageId),String(accountRef));
    },
    accept({id,accountRef,deviceId=null,createdAt=new Date().toISOString()}){
      db.exec('BEGIN IMMEDIATE');
      try{
        const row=joined(id,accountRef);
        if(!row)throw Error('suggestion_not_found');
        if(row.status!=='pending')throw Error('suggestion_already_decided');
        const created=db.prepare("INSERT INTO todos(title,status,priority,created_at,updated_at) VALUES(?,'open',0,?,?)")
          .run(row.title||'待办',createdAt,createdAt);
        const todoId=Number(created.lastInsertRowid);
        db.prepare('INSERT INTO todo_messages(todo_id,message_id,created_at) VALUES(?,?,?)')
          .run(todoId,row.message_id,createdAt);
        db.prepare("UPDATE suggestions SET status='accepted',decided_at=?,decided_device_id=? WHERE id=?")
          .run(createdAt,deviceId,Number(id));
        db.exec('COMMIT');
        return {
          suggestion:joined(id,accountRef),
          todo:db.prepare('SELECT * FROM todos WHERE id=?').get(todoId)
        };
      }catch(error){
        db.exec('ROLLBACK');
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
      let where='m.account_ref=?';
      if(status){where+=' AND t.status=?';params.push(String(status));}
      return db.prepare(`SELECT DISTINCT t.* FROM todos t
        JOIN todo_messages tm ON tm.todo_id=t.id
        JOIN messages m ON m.id=tm.message_id
        WHERE ${where} ORDER BY t.created_at DESC,t.id DESC LIMIT ?`)
        .all(...params,safeLimit);
    }
  };
}

module.exports={createSuggestionRepository};
