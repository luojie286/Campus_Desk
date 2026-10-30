const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createMessageRepository}=require('../src/db/repositories/messages.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');
const {ingestEvent}=require('../src/intake/onebot.cjs');

function setup(){
  const store=openStore(':memory:');
  applyMigrations(store.db);
  return {store,messages:createMessageRepository(store.db),jobs:createJobRepository(store.db)};
}
const config={account_id:'7007',source:{type:'group',id:'6318',sender_id:'1278',account_id:'7007'}};
const event={
  post_type:'message',message_type:'group',self_id:7007,group_id:6318,user_id:1278,
  message_id:'m1',time:1761786000,
  message:[{type:'text',data:{text:'请填写 https://docs.qq.com/sheet/abc?tab=BB08J2'}}]
};

test('intake: filters by bound source, stores message and link, enqueues one classify job',()=>{
  const {store,messages,jobs}=setup();
  const result=ingestEvent({event,config,messages,jobs});
  assert.equal(result.stored,true);
  assert.equal(result.duplicate,false);
  assert.deepEqual(result.links,['https://docs.qq.com/sheet/abc?tab=BB08J2']);
  const stored=messages.get({id:result.messageId,accountRef:'7007'});
  assert.equal(stored.source_message_id,'m1');
  assert.equal(stored.sender_id,'1278');
  assert.equal(stored.content_text.includes('请填写'),true);
  assert.deepEqual(JSON.parse(stored.link_json),['https://docs.qq.com/sheet/abc?tab=BB08J2']);
  const jobsRows=store.db.prepare('SELECT * FROM jobs').all();
  assert.equal(jobsRows.length,1);
  assert.equal(jobsRows[0].type,'classify_message');
  assert.equal(JSON.parse(jobsRows[0].payload_json).messageId,result.messageId);
  store.db.close();
});
test('intake: duplicate event is stored once and source mismatch is dropped',()=>{
  const {store,messages,jobs}=setup();
  const first=ingestEvent({event,config,messages,jobs});
  const duplicate=ingestEvent({event,config,messages,jobs});
  assert.equal(first.stored,true);
  assert.equal(duplicate.stored,false);
  assert.equal(duplicate.duplicate,true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1);
  const filtered=ingestEvent({event:{...event,user_id:999},config,messages,jobs});
  assert.equal(filtered.stored,false);
  assert.equal(filtered.reason,'source_filtered');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
  store.db.close();
});
