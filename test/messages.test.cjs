const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createMessageRepository}=require('../src/db/repositories/messages.cjs');
const {createSuggestionRepository}=require('../src/db/repositories/suggestions.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');

function setup(){
  const store=openStore(':memory:');
  applyMigrations(store.db);
  return {
    store,
    messages:createMessageRepository(store.db),
    suggestions:createSuggestionRepository(store.db),
    jobs:createJobRepository(store.db)
  };
}
const base={
  platform:'qq',adapterInstance:'onebot-main',accountRef:'7007',
  conversationType:'group',conversationId:'6318',senderId:'1278',
  sourceTime:'2026-10-30T01:00:00.000Z',receivedAt:'2026-10-30T01:00:01.000Z',
  kind:'text',contentText:'请填写报名表',contentJson:null,linkJson:'[]',
  completeness:'full',identityQuality:'stable_id',rawJson:'{}'
};

test('messages: dedupe by source id, paginate by cursor and filter by account/read state',()=>{
  const {messages,store}=setup();
  const first=messages.insert({...base,sourceMessageId:'m1'});
  const duplicate=messages.insert({...base,sourceMessageId:'m1'});
  assert.equal(first.inserted,true);
  assert.equal(duplicate.inserted,false);
  assert.equal(duplicate.id,first.id);
  messages.insert({...base,sourceMessageId:'m2',receivedAt:'2026-10-30T01:00:02.000Z',contentText:'第二条'});
  const page1=messages.list({accountRef:'7007',limit:1});
  assert.equal(page1.items.length,1);
  assert.equal(page1.items[0].source_message_id,'m2');
  assert.equal(page1.hasMore,true);
  const page2=messages.list({accountRef:'7007',limit:1,cursor:page1.nextCursor});
  assert.equal(page2.items.length,1);
  assert.equal(page2.items[0].source_message_id,'m1');
  assert.equal(page2.hasMore,false);
  assert.equal(messages.list({accountRef:'9999',limit:10}).items.length,0);
  assert.equal(messages.markRead({id:first.id,accountRef:'7007',readAt:'2026-10-30T02:00:00.000Z'}),true);
  const unread=messages.list({accountRef:'7007',limit:10,unreadOnly:true});
  assert.equal(unread.items.length,1);
  assert.equal(unread.items[0].source_message_id,'m2');
  store.db.close();
});
test('suggestions: accept creates one todo, dismiss keeps the message and account isolation applies',()=>{
  const {messages,suggestions,store}=setup();
  const m1=messages.insert({...base,sourceMessageId:'m1'});
  const m2=messages.insert({...base,sourceMessageId:'m2'});
  const s1=suggestions.insert({messageId:m1.id,messageVersion:1,kind:'todo',title:'填写报名表',summary:'群内发布了报名表',category:'form',confidence:0.9,actionJson:'{"links":["https://docs.qq.com/sheet/abc"]}',status:'pending',rationale:'含文档链接',model:'deepseek-chat',createdAt:'2026-10-30T03:00:00.000Z'});
  const s2=suggestions.insert({messageId:m2.id,messageVersion:1,kind:'todo',title:'无关消息',summary:'普通聊天',category:'chat',confidence:0.2,actionJson:'{}',status:'pending',rationale:'无行动',model:'deepseek-chat',createdAt:'2026-10-30T03:00:01.000Z'});
  assert.equal(suggestions.list({accountRef:'7007',status:'pending'}).length,2);
  assert.equal(suggestions.list({accountRef:'9999',status:'pending'}).length,0);
  assert.equal(suggestions.listForMessage({messageId:m1.id,accountRef:'7007'}).length,1);
  assert.equal(suggestions.listForMessage({messageId:m1.id,accountRef:'9999'}).length,0);
  const accepted=suggestions.accept({id:s1,accountRef:'7007',deviceId:'dev1',createdAt:'2026-10-30T04:00:00.000Z'});
  assert.equal(accepted.suggestion.status,'accepted');
  assert.equal(accepted.todo.title,'填写报名表');
  assert.equal(suggestions.listTodos({accountRef:'7007'}).length,1);
  assert.throws(()=>suggestions.accept({id:s1,accountRef:'7007',deviceId:'dev1',createdAt:'2026-10-30T04:00:01.000Z'}),/suggestion_already_decided/);
  const dismissed=suggestions.dismiss({id:s2,accountRef:'7007',deviceId:'dev1',createdAt:'2026-10-30T04:00:02.000Z'});
  assert.equal(dismissed.status,'dismissed');
  assert.equal(suggestions.list({accountRef:'7007',status:'pending'}).length,0);
  // 消息仍保留，忽略候选不等于删除来源消息。
  assert.equal(messages.get({id:m2.id,accountRef:'7007'}).id,m2.id);
  assert.throws(()=>suggestions.accept({id:s1,accountRef:'9999',deviceId:'dev1'}),/suggestion_not_found/);
  store.db.close();
});
test('jobs: claim with lease, complete, retry and recover expired leases',()=>{
  const {jobs,store}=setup();
  const id=jobs.enqueue({type:'classify_message',payload:{messageId:1},runAt:'2026-10-30T00:00:00.000Z',maxAttempts:2});
  const claimed=jobs.claim({workerId:'w1',leaseSeconds:60,now:'2026-10-30T00:00:01.000Z'});
  assert.equal(claimed.id,id);
  assert.equal(claimed.state,'running');
  assert.equal(claimed.attempts,1);
  jobs.complete(id);
  assert.equal(jobs.claim({workerId:'w1',leaseSeconds:60,now:'2026-10-30T00:00:02.000Z'}),null);
  const retryId=jobs.enqueue({type:'classify_message',payload:{messageId:2},runAt:'2026-10-30T00:00:00.000Z',maxAttempts:2});
  jobs.claim({workerId:'w1',leaseSeconds:60,now:'2026-10-30T00:00:01.000Z'});
  jobs.fail(retryId,'llm_timeout',{retryDelaySeconds:30,now:'2026-10-30T00:00:02.000Z'});
  assert.equal(jobs.claim({workerId:'w1',leaseSeconds:60,now:'2026-10-30T00:00:03.000Z'}),null);
  const second=jobs.claim({workerId:'w1',leaseSeconds:60,now:'2026-10-30T00:00:40.000Z'});
  assert.equal(second.id,retryId);
  assert.equal(second.attempts,2);
  jobs.fail(retryId,'llm_timeout',{retryDelaySeconds:30,now:'2026-10-30T00:00:41.000Z'});
  const failed=store.db.prepare('SELECT state FROM jobs WHERE id=?').get(retryId);
  assert.equal(failed.state,'failed');
  const leaseId=jobs.enqueue({type:'classify_message',payload:{messageId:3},runAt:'2026-10-30T00:00:00.000Z'});
  jobs.claim({workerId:'w1',leaseSeconds:1,now:'2026-10-30T00:00:01.000Z'});
  assert.equal(jobs.recoverExpired('2026-10-30T00:00:10.000Z'),1);
  assert.equal(jobs.claim({workerId:'w2',leaseSeconds:60,now:'2026-10-30T00:00:11.000Z'}).id,leaseId);
  store.db.close();
});
