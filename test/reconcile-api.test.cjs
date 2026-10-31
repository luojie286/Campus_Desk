const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {openStore,digest}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createTaskRepository}=require('../src/db/repositories/tasks.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');
const {createV2Handler}=require('../src/api/v2.cjs');

const now='2026-10-31T11:00:00.000Z';
const target='https://docs.qq.com/sheet/abc';
const baseConfig={token:'test-token-123',account_id:'7007',execute:true};
const plan={
  headerRow:1,identityRow:2,identityMode:'full',nameCol:1,studentCol:2,
  changes:[{row:2,col:3,field:'sex',before:'',value:'男'}]
};

function setup(){
  const store=openStore(':memory:');
  applyMigrations(store.db);
  return {
    store,
    tasks:createTaskRepository(store.db),
    jobs:createJobRepository(store.db)
  };
}

async function startServer({tasks,jobs},configOverride={}){
  const config={...baseConfig,...configOverride};
  const handler=createV2Handler({tasks,jobs,config});
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const handled=await handler(req,res,url.pathname,url.searchParams);
    if(!handled){res.statusCode=404;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'not_found'}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const auth={Authorization:'Bearer '+config.token,'Content-Type':'application/json'};
  return {
    close:()=>new Promise(resolve=>server.close(resolve)),
    call:async(path,options={})=>{
      const response=await fetch(origin+path,options);
      return {status:response.status,body:await response.json().catch(()=>null)};
    },
    auth
  };
}

// 创建 outcome_unknown 任务；operation 默认改成 unknown，便于 reconcile 前置检查。
function makeOutcomeUnknown(tasks,{accountRef='7007',markUnknown=true,requestKey='message:1:'+target}={}){
  const task=tasks.create({
    todoId:null,requestKey,kind:'doc_fill',executorType:'tencent_sheet',
    accountRef,targetRef:target,metadata:{messageId:1},createdAt:now
  });
  tasks.transition({id:task.id,accountRef,event:'start',now});
  tasks.transition({id:task.id,accountRef,event:'ready_for_approval',now});
  const saved=tasks.savePlan({taskId:task.id,plan,digest:digest(plan),createdAt:now});
  const approved=tasks.approve({
    taskId:task.id,accountRef,planId:saved.id,planVersion:saved.version,
    planDigest:saved.digest,clientRequestId:'req-'+task.id,createdAt:now
  });
  tasks.transition({id:task.id,accountRef,event:'dispatch',now});
  tasks.transition({id:task.id,accountRef,event:'unknown',now});
  if(markUnknown){
    tasks.failOperation({
      operationId:approved.operation.id,state:'unknown',errorClass:'readback_mismatch',now
    });
  }
  return {
    task:tasks.get({id:task.id,accountRef}),
    operation:tasks.getOperation({id:approved.operation.id,taskId:task.id}),
    plan:saved
  };
}

test('api: reconcile queues one deduplicated job and keeps the task unknown',async()=>{
  const {store,tasks,jobs}=setup();
  try{
    const {task,operation}=makeOutcomeUnknown(tasks);
    const server=await startServer({tasks,jobs});
    try{
      const first=await server.call('/v1/tasks/'+task.id+'/reconcile',{method:'POST',headers:server.auth,body:'{}'});
      assert.equal(first.status,202);
      assert.equal(first.body.queued,true);
      assert.equal(first.body.operation_id,operation.id);
      const second=await server.call('/v1/tasks/'+task.id+'/reconcile',{method:'POST',headers:server.auth,body:'{}'});
      assert.equal(second.status,202);
      assert.equal(second.body.job_id,first.body.job_id);
      const jobsRows=store.db.prepare("SELECT * FROM jobs WHERE type='reconcile_task'").all();
      assert.equal(jobsRows.length,1);
      assert.equal(jobsRows[0].state,'queued');
      assert.equal(tasks.get({id:task.id,accountRef:'7007'}).state,'outcome_unknown');
    }finally{await server.close();}
  }finally{store.db.close();}
});

test('api: reconcile works with execute disabled and returns the latest operation',async()=>{
  const {store,tasks,jobs}=setup();
  try{
    const {task}=makeOutcomeUnknown(tasks);
    const server=await startServer({tasks,jobs},{execute:false});
    try{
      const detail=await server.call('/v1/tasks/'+task.id,{headers:server.auth});
      assert.equal(detail.status,200);
      assert.equal(detail.body.latest_operation.state,'unknown');
      assert.equal(detail.body.latest_operation.error_class,'readback_mismatch');
      assert.equal(Object.prototype.hasOwnProperty.call(detail.body.latest_operation,'idempotency_key'),false);
      const result=await server.call('/v1/tasks/'+task.id+'/reconcile',{method:'POST',headers:server.auth,body:'{}'});
      assert.equal(result.status,202);
    }finally{await server.close();}
  }finally{store.db.close();}
});

test('api: reconcile rejects non-unknown tasks and unavailable operations',async()=>{
  const {store,tasks,jobs}=setup();
  try{
    // 状态不符：任务还在 preparing。
    const preparing=tasks.create({
      todoId:null,requestKey:'message:2:'+target,kind:'doc_fill',executorType:'tencent_sheet',
      accountRef:'7007',targetRef:target,createdAt:now
    });
    tasks.transition({id:preparing.id,accountRef:'7007',event:'start',now});
    // operation 仍为 queued：任务处于 outcome_unknown，但没有可核对的 unknown operation。
    const {task:queued}=makeOutcomeUnknown(tasks,{markUnknown:false,requestKey:'message:3:'+target});
    const server=await startServer({tasks,jobs});
    try{
      const wrongState=await server.call('/v1/tasks/'+preparing.id+'/reconcile',{method:'POST',headers:server.auth,body:'{}'});
      assert.equal(wrongState.status,409);
      assert.match(wrongState.body.error,/invalid_transition_/);
      const unavailable=await server.call('/v1/tasks/'+queued.id+'/reconcile',{method:'POST',headers:server.auth,body:'{}'});
      assert.equal(unavailable.status,409);
      assert.equal(unavailable.body.error,'reconcile_not_available');
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='reconcile_task'").get().n,0);
    }finally{await server.close();}
  }finally{store.db.close();}
});

test('api: reconcile rejects another account task',async()=>{
  const {store,tasks,jobs}=setup();
  try{
    const {task}=makeOutcomeUnknown(tasks,{accountRef:'9999',requestKey:'message:4:'+target});
    const server=await startServer({tasks,jobs});
    try{
      const result=await server.call('/v1/tasks/'+task.id+'/reconcile',{method:'POST',headers:server.auth,body:'{}'});
      assert.equal(result.status,403);
      assert.equal(result.body.error,'task_account_mismatch');
    }finally{await server.close();}
  }finally{store.db.close();}
});

test('api: resume recovers paused_login_required and failed_retryable',async()=>{
  const {store,tasks,jobs}=setup();
  try{
    const paused=tasks.create({
      todoId:null,requestKey:'message:5:'+target,kind:'doc_fill',executorType:'tencent_sheet',
      accountRef:'7007',targetRef:target,createdAt:now
    });
    tasks.transition({id:paused.id,accountRef:'7007',event:'start',now});
    tasks.transition({id:paused.id,accountRef:'7007',event:'pause_login',now});
    const retryable=tasks.create({
      todoId:null,requestKey:'message:6:'+target,kind:'doc_fill',executorType:'tencent_sheet',
      accountRef:'7007',targetRef:target,createdAt:now
    });
    tasks.transition({id:retryable.id,accountRef:'7007',event:'start',now});
    tasks.transition({id:retryable.id,accountRef:'7007',event:'fail_retryable',now});
    const server=await startServer({tasks,jobs});
    try{
      const first=await server.call('/v1/tasks/'+paused.id+'/resume',{method:'POST',headers:server.auth,body:'{}'});
      assert.equal(first.status,200);
      assert.equal(first.body.state,'preparing');
      const repeat=await server.call('/v1/tasks/'+paused.id+'/resume',{method:'POST',headers:server.auth,body:'{}'});
      assert.equal(repeat.status,409);
      const second=await server.call('/v1/tasks/'+retryable.id+'/resume',{method:'POST',headers:server.auth,body:'{}'});
      assert.equal(second.status,200);
      assert.equal(second.body.state,'preparing');
      const prepareJobs=store.db.prepare("SELECT payload_json FROM jobs WHERE type='prepare_task' ORDER BY id").all();
      assert.deepEqual(
        prepareJobs.map(row=>Number(JSON.parse(row.payload_json).taskId)).sort(),
        [paused.id,retryable.id].sort()
      );
    }finally{await server.close();}
  }finally{store.db.close();}
});

test('api: resume rejects other states without enqueueing',async()=>{
  const {store,tasks,jobs}=setup();
  try{
    const task=tasks.create({
      todoId:null,requestKey:'message:7:'+target,kind:'doc_fill',executorType:'tencent_sheet',
      accountRef:'7007',targetRef:target,createdAt:now
    });
    tasks.transition({id:task.id,accountRef:'7007',event:'start',now});
    const server=await startServer({tasks,jobs});
    try{
      const result=await server.call('/v1/tasks/'+task.id+'/resume',{method:'POST',headers:server.auth,body:'{}'});
      assert.equal(result.status,409);
      assert.match(result.body.error,/invalid_transition_/);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='prepare_task'").get().n,0);
    }finally{await server.close();}
  }finally{store.db.close();}
});
