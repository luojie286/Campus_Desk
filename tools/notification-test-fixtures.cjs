// Clearly labelled synthetic fixtures; never send QQ messages or touch real todos.
const fs=require('node:fs');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createMessageRepository}=require('../src/db/repositories/messages.cjs');
const {createSuggestionRepository}=require('../src/db/repositories/suggestions.cjs');
const config=JSON.parse(fs.readFileSync('.private/config.json','utf8'));
const ledgerPath='.private/notification-test-fixtures.json';
const ledger=fs.existsSync(ledgerPath)?JSON.parse(fs.readFileSync(ledgerPath,'utf8')):[];
const db=new DatabaseSync('.private/poc.sqlite');db.exec('PRAGMA busy_timeout=5000');
try{
 const action=process.argv[2];
 if(action==='cleanup'){
  db.exec('BEGIN IMMEDIATE');
  try{
   for(const item of ledger){
    const row=db.prepare('SELECT * FROM messages WHERE id=?').get(item.messageId);
    if(!row||row.adapter_instance!=='notification-fixture'||row.source_message_id!==item.marker)continue;
    if(item.todoId){
     if(db.prepare('SELECT count(*) n FROM tasks WHERE todo_id=?').get(item.todoId).n||db.prepare('SELECT count(*) n FROM todo_messages WHERE todo_id=? AND message_id<>?').get(item.todoId,item.messageId).n)throw Error('fixture_has_unexpected_links');
     db.prepare('DELETE FROM todo_messages WHERE todo_id=?').run(item.todoId);
     db.prepare('DELETE FROM todos WHERE id=?').run(item.todoId);
    }
    db.prepare('DELETE FROM suggestion_messages WHERE suggestion_id=?').run(item.suggestionId);
    db.prepare('DELETE FROM suggestions WHERE id=?').run(item.suggestionId);
    db.prepare('DELETE FROM message_versions WHERE message_id=?').run(item.messageId);
    db.prepare('DELETE FROM messages WHERE id=?').run(item.messageId);
   }
   db.exec('COMMIT');fs.writeFileSync(ledgerPath,'[]');console.log({cleanedSyntheticFixtures:true});
  }catch(error){db.exec('ROLLBACK');throw error;}
 }else if(['todo','notification'].includes(action)){
  const messages=createMessageRepository(db),suggestions=createSuggestionRepository(db);
  const marker='notification-fixture-'+crypto.randomUUID();
  const message=messages.insert({platform:'test',adapterInstance:'notification-fixture',accountRef:String(config.account_id),conversationType:'private',conversationId:'0',senderId:'0',sourceMessageId:marker,kind:'text',contentText:'课桌合成验收数据',receivedAt:new Date().toISOString()});
  const suggestionId=suggestions.insert({messageId:message.id,title:action==='todo'?'课桌待办操作测试':'课桌后台通知测试',kind:'todo'});
  const item={marker,messageId:message.id,suggestionId};
  if(action==='todo'){
   item.todoId=suggestions.accept({id:suggestionId,accountRef:String(config.account_id)}).todo.id;
   fs.writeFileSync('.private/todo-device-fixture.json',JSON.stringify({id:item.todoId,title:'课桌待办操作测试'}));
  }
  ledger.push(item);fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2));
  console.log({created:action,synthetic:true,...(item.todoId?{todoId:item.todoId}:{suggestionId})});
 }else throw Error('use_todo_notification_cleanup');
}finally{db.close();}
