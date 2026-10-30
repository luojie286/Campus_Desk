const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore,digest}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createTaskRepository}=require('../src/db/repositories/tasks.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');
const {processNextExecuteJob}=require('../src/worker/execute.cjs');

const now='2026-10-30T10:00:00.000Z';
const target='https://docs.qq.com/sheet/abc';
const profile={name:'示例学生',student_id:'202500000000',sex:'男'};
const plan={headerRow:1,identityRow:2,identityMode:'full',nameCol:1,studentCol:2,changes:[{row:2,col:3,field:'sex',before:'',value:'男'}]};
function setup(){
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
  jobs.enqueue({type:'execute_operation',payload:{taskId:task.id,accountRef:'7007',operationId:approved.operation.id},runAt:now,maxAttempts:1});
  return {store,tasks,jobs,task,operation:approved.operation,plan:saved};
}
function grid(){return [['姓名','学号','性别'],['示例学生','202500000000','']];}
function deps(sheet,tasks,jobs,config={execute:true}){
  return {tasks,jobs,config,workerId:'w1',now,fields:()=>profile,createSheet:()=>sheet};
}
test('execute: writes the approved plan and verifies by reading back',async()=>{
  const {store,tasks,jobs,task,operation}=setup();
  let applied=null;
  const sheet={
    async open(){},
    async readUsedRange(){return grid();},
    async isEditable(){return true;},
    async applyGeneral(value){applied=value;},
    async verifyGeneral(){return true;},
    async close(){}
  };
  const result=await processNextExecuteJob(deps(sheet,tasks,jobs));
  assert.equal(result.processed,true);
  assert.equal(result.state,'completed');
  assert.equal(applied.changes[0].value,'男');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'completed');
  assert.equal(tasks.getOperation({id:operation.id,taskId:task.id}).state,'completed');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document_locks').get().n,0);
  assert.equal(jobs.claim({workerId:'w2',type:'execute_operation',now:'2026-10-30T10:00:01.000Z'}),null);
  store.db.close();
});
test('execute: readback mismatch becomes outcome_unknown and is not retried',async()=>{
  const {store,tasks,jobs,task,operation}=setup();
  const sheet={
    async open(){},
    async readUsedRange(){return grid();},
    async isEditable(){return true;},
    async applyGeneral(){},
    async verifyGeneral(){return false;},
    async close(){}
  };
  const result=await processNextExecuteJob(deps(sheet,tasks,jobs));
  assert.equal(result.processed,true);
  assert.equal(result.state,'outcome_unknown');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'outcome_unknown');
  assert.equal(tasks.getOperation({id:operation.id,taskId:task.id}).state,'unknown');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='execute_operation' AND state='queued'").get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document_locks').get().n,0);
  store.db.close();
});
test('execute: a write exception is outcome_unknown, never a retry that rewrites',async()=>{
  const {store,tasks,jobs,task,operation}=setup();
  const sheet={
    async open(){},
    async readUsedRange(){return grid();},
    async isEditable(){return true;},
    async applyGeneral(){throw Error('network_lost_during_write');},
    async verifyGeneral(){return true;},
    async close(){}
  };
  const result=await processNextExecuteJob(deps(sheet,tasks,jobs));
  assert.equal(result.processed,true);
  assert.equal(result.state,'outcome_unknown');
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'outcome_unknown');
  assert.equal(tasks.getOperation({id:operation.id,taskId:task.id}).state,'unknown');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='execute_operation' AND state='queued'").get().n,0);
  store.db.close();
});
test('execute: the execute switch is checked again before any write',async()=>{
  const {store,tasks,jobs,task,operation}=setup();
  let applied=false;
  const sheet={
    async open(){},
    async readUsedRange(){return grid();},
    async isEditable(){return true;},
    async applyGeneral(){applied=true;},
    async verifyGeneral(){return true;},
    async close(){}
  };
  const result=await processNextExecuteJob(deps(sheet,tasks,jobs,{execute:false}));
  assert.equal(result.processed,true);
  assert.equal(result.error,'execute_disabled');
  assert.equal(applied,false);
  assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'approved');
  assert.equal(tasks.getOperation({id:operation.id,taskId:task.id}).state,'failed_retryable');
  store.db.close();
});
