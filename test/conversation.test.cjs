const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createMessageRepository}=require('../src/db/repositories/messages.cjs');
const {createSuggestionRepository}=require('../src/db/repositories/suggestions.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');
const {createFileRepository}=require('../src/db/repositories/files.cjs');
const {processNextConversationJob}=require('../src/worker/conversation.cjs');

const now='2026-10-30T14:00:00.000Z';
const testDir=fs.mkdtempSync(path.join(os.tmpdir(),'campus-desk-conversation-'));
after(()=>fs.rmSync(testDir,{recursive:true,force:true}));
const base={
  platform:'qq',adapterInstance:'onebot-main',accountRef:'7007',conversationType:'group',
  conversationId:'6318',senderId:'1278',sourceTime:now,receivedAt:now,kind:'text',
  contentJson:null,linkJson:'[]',completeness:'full',identityQuality:'stable_id',rawJson:'{}'
};
function setup(){
  const store=openStore(':memory:');
  applyMigrations(store.db);
  return {
    store,
    messages:createMessageRepository(store.db),
    suggestions:createSuggestionRepository(store.db),
    jobs:createJobRepository(store.db),
    files:createFileRepository(store.db)
  };
}
function enqueue(jobs,runAt=now){
  return jobs.enqueue({
    type:'suggest_conversation',
    payload:{accountRef:'7007',conversationType:'group',conversationId:'6318'},
    runAt,
    maxAttempts:1
  });
}
test('conversation: obvious chatter is filtered and the cursor advances',async()=>{
  const {store,messages,suggestions,jobs}=setup();
  const m=messages.insert({...base,sourceMessageId:'m1',contentText:'今天天气真不错，大家下午有空吗'});
  const jobId=enqueue(jobs);
  const result=await processNextConversationJob({
    messages,suggestions,jobs,config:{},workerId:'w1',now,
    suggest:async()=>({actionable:false,reason:'纯闲聊'})
  });
  assert.equal(result.processed,true);
  assert.equal(result.state,'filtered');
  assert.equal(suggestions.list({accountRef:'7007',status:'pending'}).length,0);
  assert.equal(messages.conversationCursor({accountRef:'7007',conversationType:'group',conversationId:'6318'}).last_message_id,m.id);
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId).state,'done');
  store.db.close();
});
test('conversation: messages about the same event merge into one candidate',async()=>{
  const {store,messages,suggestions,jobs}=setup();
  const first=messages.insert({...base,sourceMessageId:'m1',contentText:'实验室安全培训改到周五下午'});
  enqueue(jobs);
  await processNextConversationJob({
    messages,suggestions,jobs,config:{},workerId:'w1',now,
    suggest:async({payload})=>{
      assert.equal(payload.messages.length,1);
      return {actionable:true,thread_key:'lab-safety',title:'参加实验室安全培训',summary:'培训改到周五下午',category:'action',confidence:0.9,rationale:'通知改期',message_ids:[first.id]};
    }
  });
  const second=messages.insert({...base,sourceMessageId:'m2',contentText:'培训地点也改到实验楼 302'});
  enqueue(jobs,'2026-10-30T14:01:00.000Z');
  await processNextConversationJob({
    messages,suggestions,jobs,config:{},workerId:'w1',now:'2026-10-30T14:01:01.000Z',
    suggest:async({payload})=>{
      assert.equal(payload.messages.length,1);
      assert.equal(payload.existing.length,1);
      assert.equal(payload.existing[0].thread_key,'lab-safety');
      return {actionable:true,thread_key:'lab-safety',title:'参加实验室安全培训',summary:'周五下午在实验楼 302',category:'action',confidence:0.95,rationale:'同一培训',message_ids:[second.id]};
    }
  });
  const pending=suggestions.list({accountRef:'7007',status:'pending'});
  assert.equal(pending.length,1);
  assert.equal(pending[0].thread_key,'lab-safety');
  assert.equal(pending[0].source_count,2);
  const sources=store.db.prepare('SELECT message_id FROM suggestion_messages WHERE suggestion_id=? ORDER BY message_id').all(pending[0].id);
  assert.deepEqual(sources.map(row=>row.message_id),[first.id,second.id]);
  store.db.close();
});
test('conversation: accepting a merged candidate links all source messages',async()=>{
  const {store,messages,suggestions,jobs}=setup();
  const first=messages.insert({...base,sourceMessageId:'m1',contentText:'周五前提交实验报告'});
  const second=messages.insert({...base,sourceMessageId:'m2',contentText:'实验报告模板已发群文件'});
  const rid=suggestions.insert({
    messageId:first.id,messageVersion:1,kind:'todo',title:'提交实验报告',summary:'周五前提交',
    category:'action',confidence:0.9,actionJson:{},status:'pending',rationale:'通知',
    model:'test',createdAt:now,accountRef:'7007',conversationType:'group',conversationId:'6318',
    threadKey:'lab-report',messageIds:[first.id,second.id]
  });
  const accepted=suggestions.accept({id:rid,accountRef:'7007',createdAt:now});
  const links=store.db.prepare('SELECT message_id FROM todo_messages WHERE todo_id=? ORDER BY message_id').all(accepted.todo.id);
  assert.deepEqual(links.map(row=>row.message_id),[first.id,second.id]);
  store.db.close();
});
test('conversation: extracted file text joins the same LLM batch',async()=>{
  const {store,messages,suggestions,jobs,files}=setup();
  const message=messages.insert({...base,sourceMessageId:'m-file',kind:'file',contentText:'Word 附件'});
  const file=files.insert({
    messageId:message.id,accountRef:'7007',platformFileId:'f1',fileName:'通知.docx',
    mimeType:null,sizeBytes:100,createdAt:now
  });
  const textPath=path.join(testDir,'notice.txt');
  fs.writeFileSync(textPath,'Word 通知正文：请提交推荐表。','utf8');
  files.markTextExtracted({id:file.id,textPath,now});
  enqueue(jobs);
  let seen=null;
  const result=await processNextConversationJob({
    files,messages,suggestions,jobs,config:{},workerId:'w1',now,
    suggest:async({payload})=>{
      seen=payload;
      return {actionable:true,thread_key:'docx-notice',title:'提交推荐表',summary:'Word 通知',category:'action',confidence:0.9,rationale:'附件',message_ids:[message.id]};
    }
  });
  assert.equal(result.processed,true);
  assert.equal(seen.messages.length,1);
  assert.equal(seen.messages[0].text.includes('Word 通知正文'),true);
  assert.equal(seen.messages[0].text.includes('附件'),true);
  assert.equal(suggestions.list({accountRef:'7007',status:'pending'}).length,1);
  store.db.close();
});
test('conversation: a new message for the same conversation is debounced into one queued job',()=>{
  const {store,jobs}=setup();
  const first=jobs.enqueueUnique({type:'suggest_conversation',payload:{conversationId:'6318'},runAt:'2026-10-30T14:00:30.000Z',dedupeKey:'suggest:7007:group:6318'});
  const second=jobs.enqueueUnique({type:'suggest_conversation',payload:{conversationId:'6318'},runAt:'2026-10-30T14:01:00.000Z',dedupeKey:'suggest:7007:group:6318'});
  assert.equal(first,second);
  const rows=store.db.prepare('SELECT * FROM jobs WHERE dedupe_key=?').all('suggest:7007:group:6318');
  assert.equal(rows.length,1);
  assert.equal(rows[0].run_at,'2026-10-30T14:01:00.000Z');
  store.db.close();
});
