const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore,digest}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createTaskRepository}=require('../src/db/repositories/tasks.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');
const {processNextExecuteJob}=require('../src/worker/execute.cjs');
const {processNextReconcileJob}=require('../src/worker/reconcile.cjs');

const now='2026-10-31T10:00:00.000Z';
const target='https://docs.qq.com/sheet/abc';
const profile={name:'示例学生',student_id:'202500000000',sex:'男'};
const plan={
  headerRow:1,identityRow:2,identityMode:'full',nameCol:1,studentCol:2,
  changes:[{row:2,col:3,field:'sex',before:'',value:'男'}]
};
function grid(value){
  return [['姓名','学号','性别'],['示例学生','202500000000',value]];
}

// 先用 execute worker 制造一个真实的 outcome_unknown + operation unknown 任务。
async function setupUnknown(){
  const store=openStore(':memory:');
  applyMigrations(store.db);
  const tasks=createTaskRepository(store.db);
  const jobs=createJobRepository(store.db);
  const task=tasks.create({
    todoId:null,requestKey:'message:1:'+target,kind:'doc_fill',executorType:'tencent_sheet',
    accountRef:'7007',targetRef:target,metadata:{messageId:1},createdAt:now
  });
  tasks.transition({id:task.id,accountRef:'7007',event:'start',now});
  tasks.transition({id:task.id,accountRef:'7007',event:'ready_for_approval',now});
  const saved=tasks.savePlan({taskId:task.id,plan,digest:digest(plan),createdAt:now});
  const approved=tasks.approve({
    taskId:task.id,accountRef:'7007',planId:saved.id,planVersion:saved.version,
    planDigest:saved.digest,clientRequestId:'req-1',createdAt:now
  });
  jobs.enqueue({
    type:'execute_operation',
    payload:{taskId:task.id,accountRef:'7007',operationId:approved.operation.id},
    runAt:now,maxAttempts:1
  });
  const executeSheet={
    async open(){},
    async readUsedRange(){return grid('');},
    async isEditable(){return true;},
    async applyGeneral(){},
    async verifyGeneral(){return false;},
    async close(){}
  };
  const executed=await processNextExecuteJob({
    tasks,jobs,config:{execute:true},workerId:'w0',now,
    fields:()=>profile,createSheet:()=>executeSheet
  });
  assert.equal(executed.state,'outcome_unknown');
  const operation=tasks.getOperation({id:approved.operation.id,taskId:task.id});
  assert.equal(operation.state,'unknown');
  return {store,tasks,jobs,task,operation,plan:saved};
}

function enqueueReconcile(jobs,task,operation,maxAttempts=3){
  return jobs.enqueue({
    type:'reconcile_task',
    payload:{taskId:task.id,accountRef:'7007',operationId:operation.id},
    runAt:now,maxAttempts
  });
}

function fakeSheet(value,{editable=true,openError=null,readError=null}={}){
  const state={writes:0,reads:0,opens:0,closed:0};
  return {
    state,
    async open(){state.opens++;if(openError)throw Error(openError);},
    async isEditable(){return editable;},
    async readUsedRange(){state.reads++;if(readError)throw Error(readError);return grid(value);},
    async applyGeneral(){state.writes++;throw Error('reconcile_must_not_write');},
    async close(){state.closed++;}
  };
}

test('reconcile: matching values complete the task without writing',async()=>{
  const {store,tasks,jobs,task,operation}=await setupUnknown();
  enqueueReconcile(jobs,task,operation);
  const sheet=fakeSheet('男');
  const result=await processNextReconcileJob({tasks,jobs,config:{},workerId:'w1',now,createSheet:()=>sheet});
  assert.equal(result.processed,true);
  assert.equal(result.state,'completed');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'completed');
  const current=tasks.getOperation({id:operation.id,taskId:task.id});
  assert.equal(current.state,'completed');
  assert.equal(current.error_class,null);
  assert.equal(JSON.parse(current.evidence_json).reconciled,true);
  assert.equal(sheet.state.writes,0);
  assert.equal(sheet.state.closed,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document_locks').get().n,0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='reconcile_task' AND state='done'").get().n,1);
  store.db.close();
});

test('reconcile: mismatched values stay outcome_unknown and never write',async()=>{
  const {store,tasks,jobs,task,operation}=await setupUnknown();
  enqueueReconcile(jobs,task,operation);
  const sheet=fakeSheet('');
  const result=await processNextReconcileJob({tasks,jobs,config:{},workerId:'w1',now,createSheet:()=>sheet});
  assert.equal(result.processed,true);
  assert.equal(result.error,'manual_reconciliation_required');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'outcome_unknown');
  const current=tasks.getOperation({id:operation.id,taskId:task.id});
  assert.equal(current.state,'unknown');
  assert.equal(current.error_class,'manual_reconciliation_required');
  const evidence=JSON.parse(current.evidence_json);
  assert.equal(evidence.reconciled,false);
  assert.equal(evidence.matched,0);
  assert.equal(evidence.total,1);
  assert.equal(evidence.mismatches[0].cell,'C2');
  // 证据只保存地址和字段，不保存姓名或拟填值。
  assert.equal(JSON.stringify(evidence).includes('示例学生'),false);
  assert.equal(JSON.stringify(evidence).includes('男'),false);
  assert.equal(sheet.state.writes,0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='reconcile_task' AND state='done'").get().n,1);
  store.db.close();
});

test('reconcile: login required leaves the task unknown without auto-retry',async()=>{
  const {store,tasks,jobs,task,operation}=await setupUnknown();
  enqueueReconcile(jobs,task,operation);
  const sheet=fakeSheet('男',{editable:false});
  const result=await processNextReconcileJob({tasks,jobs,config:{},workerId:'w1',now,createSheet:()=>sheet});
  assert.equal(result.processed,true);
  assert.equal(result.error,'login_required');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'outcome_unknown');
  const current=tasks.getOperation({id:operation.id,taskId:task.id});
  assert.equal(current.state,'unknown');
  assert.equal(current.error_class,'login_required');
  assert.equal(sheet.state.reads,0);
  assert.equal(sheet.state.writes,0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='reconcile_task' AND state='done'").get().n,1);
  store.db.close();
});

test('reconcile: a stale job for a non-outcome_unknown task is skipped',async()=>{
  const store=openStore(':memory:');
  applyMigrations(store.db);
  const tasks=createTaskRepository(store.db);
  const jobs=createJobRepository(store.db);
  const task=tasks.create({
    todoId:null,requestKey:'message:2:'+target,kind:'doc_fill',executorType:'tencent_sheet',
    accountRef:'7007',targetRef:target,createdAt:now
  });
  tasks.transition({id:task.id,accountRef:'7007',event:'start',now});
  const jobId=jobs.enqueue({
    type:'reconcile_task',payload:{taskId:task.id,accountRef:'7007'},runAt:now,maxAttempts:1
  });
  const sheet=fakeSheet('男');
  const result=await processNextReconcileJob({tasks,jobs,config:{},workerId:'w1',now,createSheet:()=>sheet});
  assert.equal(result.processed,true);
  assert.equal(result.skipped,true);
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'preparing');
  assert.equal(sheet.state.opens,0);
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId).state,'done');
  store.db.close();
});

test('reconcile: a document lock held by another worker requeues the job',async()=>{
  const {store,tasks,jobs,task,operation}=await setupUnknown();
  assert.equal(tasks.acquireLock({lockKey:target,ownerId:'other',ttlSeconds:300,now}),true);
  enqueueReconcile(jobs,task,operation);
  const sheet=fakeSheet('男');
  const result=await processNextReconcileJob({tasks,jobs,config:{},workerId:'w1',now,createSheet:()=>sheet});
  assert.equal(result.processed,true);
  assert.equal(result.error,'document_busy');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'outcome_unknown');
  assert.equal(sheet.state.opens,0);
  const job=store.db.prepare("SELECT state,run_at FROM jobs WHERE type='reconcile_task' ORDER BY id DESC LIMIT 1").get();
  assert.equal(job.state,'queued');
  assert.ok(job.run_at>now);
  store.db.close();
});

test('reconcile: missing operation fails the task terminally',async()=>{
  const store=openStore(':memory:');
  applyMigrations(store.db);
  const tasks=createTaskRepository(store.db);
  const jobs=createJobRepository(store.db);
  const task=tasks.create({
    todoId:null,requestKey:'message:3:'+target,kind:'doc_fill',executorType:'tencent_sheet',
    accountRef:'7007',targetRef:target,createdAt:now
  });
  tasks.transition({id:task.id,accountRef:'7007',event:'start',now});
  tasks.transition({id:task.id,accountRef:'7007',event:'ready_for_approval',now});
  // 直接走状态机，不经过 approve，故意不创建 operation。
  tasks.transition({id:task.id,accountRef:'7007',event:'approve',now});
  tasks.transition({id:task.id,accountRef:'7007',event:'dispatch',now});
  tasks.transition({id:task.id,accountRef:'7007',event:'unknown',now});
  const jobId=jobs.enqueue({
    type:'reconcile_task',payload:{taskId:task.id,accountRef:'7007'},runAt:now,maxAttempts:1
  });
  const sheet=fakeSheet('男');
  const result=await processNextReconcileJob({tasks,jobs,config:{},workerId:'w1',now,createSheet:()=>sheet});
  assert.equal(result.error,'operation_not_found');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'failed_terminal');
  assert.equal(sheet.state.opens,0);
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId).state,'done');
  store.db.close();
});

test('reconcile: an empty or invalid plan fails and does not count as matched',async()=>{
  const {store,tasks,jobs,task,operation,plan:saved}=await setupUnknown();
  store.db.prepare('UPDATE plans SET plan_json=? WHERE id=?').run(JSON.stringify({changes:[]}),saved.id);
  enqueueReconcile(jobs,task,operation);
  const sheet=fakeSheet('男');
  const result=await processNextReconcileJob({tasks,jobs,config:{},workerId:'w1',now,createSheet:()=>sheet});
  assert.equal(result.error,'plan_invalid');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'failed_terminal');
  assert.equal(tasks.getOperation({id:operation.id,taskId:task.id}).error_class,'plan_invalid');
  assert.equal(sheet.state.opens,0);
  store.db.close();
});

test('reconcile: a transient read error requeues the job and keeps the task unknown',async()=>{
  const {store,tasks,jobs,task,operation}=await setupUnknown();
  enqueueReconcile(jobs,task,operation);
  const sheet=fakeSheet('男',{readError:'clipboard_read_failed'});
  const result=await processNextReconcileJob({tasks,jobs,config:{},workerId:'w1',now,createSheet:()=>sheet});
  assert.equal(result.error,'clipboard_read_failed');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'outcome_unknown');
  const current=tasks.getOperation({id:operation.id,taskId:task.id});
  assert.equal(current.state,'unknown');
  const job=store.db.prepare("SELECT state,run_at FROM jobs WHERE type='reconcile_task' ORDER BY id DESC LIMIT 1").get();
  assert.equal(job.state,'queued');
  assert.ok(job.run_at>now);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document_locks').get().n,0);
  store.db.close();
});

test('reconcile: a login-helper-open error is not retried',async()=>{
  const {store,tasks,jobs,task,operation}=await setupUnknown();
  enqueueReconcile(jobs,task,operation);
  const sheet=fakeSheet('男',{openError:'document_login_window_open_close_it_first'});
  const result=await processNextReconcileJob({tasks,jobs,config:{},workerId:'w1',now,createSheet:()=>sheet});
  assert.equal(result.error,'document_login_window_open_close_it_first');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'outcome_unknown');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='reconcile_task' AND state='done'").get().n,1);
  store.db.close();
});
