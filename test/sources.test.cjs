const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createMessageRepository}=require('../src/db/repositories/messages.cjs');
const {createSourceRepository}=require('../src/db/repositories/sources.cjs');
const {normalizeOneBotEvent,ingestEvent}=require('../src/intake/onebot.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');

const now='2026-10-30T15:00:00.000Z';
const event={
  post_type:'message',message_type:'group',self_id:7007,group_id:6318,user_id:1278,
  message_id:'m1',time:1761786000,
  sender:{card:'班级备注',nickname:'昵称'},
  message:[{type:'text',data:{text:'请查看通知'}}]
};
function setup(){
  const store=openStore(':memory:');
  applyMigrations(store.db);
  return {
    store,
    sources:createSourceRepository(store.db),
    messages:createMessageRepository(store.db),
    jobs:createJobRepository(store.db)
  };
}
test('sources: add, match by IDs, update display name and remove',()=>{
  const {store,sources}=setup();
  const added=sources.add({accountRef:'7007',conversationType:'group',conversationId:'6318',senderId:'1278',displayName:'实验室群',now});
  assert.equal(sources.list({accountRef:'7007'}).length,1);
  assert.equal(sources.matchEvent(event,{accountRef:'7007'}).id,added.id);
  assert.equal(sources.matchEvent({...event,user_id:9999},{accountRef:'7007'}),null);
  assert.equal(sources.matchEvent({...event,self_id:9999},{accountRef:'7007'}),null);
  assert.equal(sources.updateDisplayName({id:added.id,accountRef:'7007',displayName:'新群名',now}),true);
  assert.equal(sources.get({id:added.id,accountRef:'7007'}).display_name,'新群名');
  assert.equal(sources.remove({id:added.id,accountRef:'7007'}),true);
  assert.equal(sources.list({accountRef:'7007'}).length,0);
  store.db.close();
});
test('sources: seeding from config and message names use group remark first',()=>{
  const {store,sources,messages,jobs}=setup();
  const seeded=sources.seedFromConfig({accountRef:'7007',source:{type:'group',id:'6318',sender_id:'1278'},displayName:'发送者昵称',now});
  // 群名不能从成员昵称推断；由联系人刷新写入。
  assert.equal(sources.get({id:seeded.id,accountRef:'7007'}).display_name,null);
  sources.updateDisplayName({id:seeded.id,accountRef:'7007',displayName:'实验室群',now});
  const config={account_id:'7007',source:{type:'group',id:'6318',sender_id:'1278'}};
  const normalized=normalizeOneBotEvent(event,config,sources.toLegacySource(sources.list({accountRef:'7007'})[0]));
  assert.equal(normalized.message.senderName,'班级备注');
  assert.equal(normalized.message.conversationName,'实验室群');
  const result=ingestEvent({event,config,messages,jobs,source:sources.toLegacySource(sources.list({accountRef:'7007'})[0]),now});
  const row=messages.get({id:result.messageId,accountRef:'7007'});
  assert.equal(row.sender_name,'班级备注');
  assert.equal(row.conversation_name,'实验室群');
  assert.equal(messages.sources({accountRef:'7007'})[0].conversation_name,'实验室群');
  assert.equal(messages.sources({accountRef:'7007'})[0].last_sender_name,'班级备注');
  store.db.close();
});
test('sources: backfill names from stored raw events',()=>{
  const {store,sources,messages}=setup();
  const result=messages.insert({
    platform:'qq',adapterInstance:'onebot-main',accountRef:'7007',conversationType:'group',
    conversationId:'6318',senderId:'1278',sourceMessageId:'m-backfill',receivedAt:now,
    kind:'text',contentText:'x',linkJson:'[]',rawJson:JSON.stringify(event)
  });
  sources.add({accountRef:'7007',conversationType:'group',conversationId:'6318',displayName:'实验室群',now});
  messages.backfillNames({accountRef:'7007'});
  const row=messages.get({id:result.id,accountRef:'7007'});
  assert.equal(row.sender_name,'班级备注');
  assert.equal(row.conversation_name,'实验室群');
  store.db.close();
});
