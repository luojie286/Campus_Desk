const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createMessageRepository}=require('../src/db/repositories/messages.cjs');
const {createSuggestionRepository}=require('../src/db/repositories/suggestions.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');
const {createClassificationRepository}=require('../src/db/repositories/classifications.cjs');
const {createTaskRepository}=require('../src/db/repositories/tasks.cjs');
const {processNextClassifyJob}=require('../src/worker/classify.cjs');

const now='2026-10-30T05:00:00.000Z';
const base={
  platform:'qq',adapterInstance:'onebot-main',accountRef:'7007',conversationType:'group',
  conversationId:'6318',senderId:'1278',sourceTime:now,receivedAt:now,kind:'text',
  contentJson:null,completeness:'full',identityQuality:'stable_id',rawJson:'{}'
};
function setup(){
  const store=openStore(':memory:');
  applyMigrations(store.db);
  return {
    store,
    messages:createMessageRepository(store.db),
    suggestions:createSuggestionRepository(store.db),
    jobs:createJobRepository(store.db),
    classifications:createClassificationRepository(store.db),
    tasks:createTaskRepository(store.db)
  };
}
test('worker: classification does not consume prepared-task jobs',async()=>{
  const {store,messages,suggestions,jobs,classifications,tasks}=setup();
  const prepareId=jobs.enqueue({type:'prepare_task',payload:{taskId:1},runAt:now,maxAttempts:1});
  const result=await processNextClassifyJob({messages,suggestions,jobs,classifications,tasks,config:{},workerId:'w1',now});
  assert.equal(result.processed,false);
  const job=store.db.prepare('SELECT state,attempts FROM jobs WHERE id=?').get(prepareId);
  assert.equal(job.state,'queued');
  assert.equal(job.attempts,0);
  store.db.close();
});
test('worker: non-link chat is queued for conversation filtering, not per-message LLM',async()=>{
  const {store,messages,suggestions,jobs,classifications,tasks}=setup();
  const msg=messages.insert({...base,sourceMessageId:'m1',contentText:'哈哈',linkJson:'[]'});
  jobs.enqueue({type:'classify_message',payload:{messageId:msg.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const result=await processNextClassifyJob({messages,suggestions,jobs,classifications,tasks,config:{},workerId:'w1',now});
  assert.equal(result.processed,true);
  assert.equal(result.classification.category,'chat');
  assert.equal(suggestions.list({accountRef:'7007',status:'pending'}).length,0);
  const queued=store.db.prepare("SELECT * FROM jobs WHERE type='suggest_conversation'").all();
  assert.equal(queued.length,1);
  assert.equal(queued[0].state,'queued');
  assert.equal(JSON.parse(queued[0].payload_json).conversationId,'6318');
  assert.equal(queued[0].run_at,'2026-10-30T05:00:30.000Z');
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE id=?").get(result.jobId).state,'done');
  store.db.close();
});
test('worker: document link creates a fill task directly and enqueues preparation',async()=>{
  const {store,messages,suggestions,jobs,classifications,tasks}=setup();
  const msg=messages.insert({...base,sourceMessageId:'m2',contentText:'请填写报名表',linkJson:'["https://docs.qq.com/sheet/abc"]'});
  jobs.enqueue({type:'classify_message',payload:{messageId:msg.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const result=await processNextClassifyJob({messages,suggestions,jobs,classifications,tasks,config:{},workerId:'w1',now});
  assert.equal(result.processed,true);
  assert.equal(result.classification.category,'form');
  assert.equal(result.suggestionId,null);
  assert.equal(result.tasks.length,1);
  assert.equal(result.tasks[0].target_ref,'https://docs.qq.com/sheet/abc');
  assert.equal(result.tasks[0].state,'created');
  assert.equal(suggestions.list({accountRef:'7007',status:'pending'}).length,0);
  const prepareJobs=store.db.prepare("SELECT * FROM jobs WHERE type='prepare_task'").all();
  assert.equal(prepareJobs.length,1);
  assert.equal(JSON.parse(prepareJobs[0].payload_json).taskId,result.tasks[0].id);
  const latest=classifications.latestForMessage(msg.id);
  assert.equal(latest.category,'form');
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE id=?").get(result.jobId).state,'done');
  store.db.close();
});
test('worker: non-link messages are aggregated and a missing message fails the job',async()=>{
  const {store,messages,suggestions,jobs,classifications,tasks}=setup();
  const msg=messages.insert({...base,sourceMessageId:'m3',contentText:'请提交材料',linkJson:'[]'});
  jobs.enqueue({type:'classify_message',payload:{messageId:msg.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const first=await processNextClassifyJob({messages,suggestions,jobs,classifications,tasks,config:{},workerId:'w1',now});
  assert.equal(first.processed,true);
  assert.equal(suggestions.list({accountRef:'7007',status:'pending'}).length,0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='suggest_conversation'").get().n,1);
  jobs.enqueue({type:'classify_message',payload:{messageId:999,accountRef:'7007'},runAt:now,maxAttempts:1});
  const missing=await processNextClassifyJob({messages,suggestions,jobs,classifications,tasks,config:{},workerId:'w1',now});
  assert.equal(missing.processed,true);
  assert.equal(missing.error,'message_not_found');
  const failed=store.db.prepare("SELECT state,last_error FROM jobs WHERE id=?").get(missing.jobId);
  assert.equal(failed.state,'failed');
  assert.equal(failed.last_error,'message_not_found');
  store.db.close();
});
