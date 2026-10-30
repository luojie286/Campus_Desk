const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {openStore,digest}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createTaskRepository}=require('../src/db/repositories/tasks.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');
const {createV2Handler}=require('../src/api/v2.cjs');

const now='2026-10-30T09:00:00.000Z';
const target='https://docs.qq.com/sheet/abc';
const config={token:'test-token-123',account_id:'7007',execute:true};
function setup(){
  const store=openStore(':memory:');
  applyMigrations(store.db);
  const tasks=createTaskRepository(store.db);
  const jobs=createJobRepository(store.db);
  const task=tasks.create({
    todoId:null,requestKey:'message:1:'+target,kind:'doc_fill',executorType:'tencent_sheet',
    accountRef:'7007',targetRef:target,metadata:{messageId:1},createdAt:now
  });
  return {store,tasks,jobs,task};
}
async function startServer(deps){
  const handler=createV2Handler({...deps,config});
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const handled=await handler(req,res,url.pathname,url.searchParams);
    if(!handled){res.statusCode=404;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'not_found'}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const auth={Authorization:'Bearer '+config.token,'Content-Type':'application/json'};
  return {
    origin,
    auth,
    close:()=>new Promise(resolve=>server.close(resolve)),
    call:async(path,options={})=>{
      const response=await fetch(origin+path,options);
      return {status:response.status,body:await response.json().catch(()=>null)};
    }
  };
}
test('api: task detail, answers, approval idempotency and account isolation',async()=>{
  const {store,tasks,jobs,task}=setup();
  // 模拟 prepare worker 已发现缺字段并进入问答。
  tasks.transition({id:task.id,accountRef:'7007',event:'start',now});
  const input=tasks.transition({id:task.id,accountRef:'7007',event:'need_input',now});
  tasks.setQuestions({taskId:task.id,taskVersion:input.state_version,questions:[{key:'sex',label:'性别',kind:'text',reason:'profile_value_missing'}],createdAt:now});
  const server=await startServer({tasks,jobs});
  try{
    const list=await server.call('/v1/tasks',{headers:server.auth});
    assert.equal(list.status,200);
    assert.equal(list.body.items.length,1);
    assert.equal(list.body.items[0].id,task.id);
    const detail=await server.call('/v1/tasks/'+task.id,{headers:server.auth});
    assert.equal(detail.status,200);
    assert.equal(detail.body.state,'awaiting_input');
    assert.equal(detail.body.questions.length,1);
    const bad=await server.call('/v1/tasks/'+task.id+'/answers',{
      method:'POST',headers:server.auth,body:JSON.stringify({answers:[{key:'unknown',value:'x'}]})
    });
    assert.equal(bad.status,400);
    const answer=await server.call('/v1/tasks/'+task.id+'/answers',{
      method:'POST',headers:server.auth,body:JSON.stringify({answers:[{key:'sex',value:'男'}]})
    });
    assert.equal(answer.status,200);
    assert.equal(answer.body.state,'preparing');
    const prepareJobs=store.db.prepare("SELECT type,state FROM jobs WHERE type='prepare_task'").all();
    assert.equal(prepareJobs.length,1);
    assert.equal(prepareJobs[0].state,'queued');

    // 模拟回答后准备 worker 生成新计划。
    tasks.transition({id:task.id,accountRef:'7007',event:'ready_for_approval',now});
    const plan={changes:[{row:2,col:3,field:'sex',before:'',value:'男'}]};
    const saved=tasks.savePlan({taskId:task.id,plan,digest:digest(plan),createdAt:now});
    const preview=await server.call('/v1/tasks/'+task.id+'/plan',{headers:server.auth});
    assert.equal(preview.status,200);
    assert.equal(preview.body.plan.changes[0].value,'男');
    const approvalBody={plan_id:saved.id,plan_version:saved.version,plan_digest:saved.digest,client_request_id:'req-1'};
    const approved=await server.call('/v1/tasks/'+task.id+'/approvals',{
      method:'POST',headers:server.auth,body:JSON.stringify(approvalBody)
    });
    assert.equal(approved.status,200);
    assert.equal(approved.body.task.state,'approved');
    assert.equal(approved.body.operation.state,'queued');
    const repeat=await server.call('/v1/tasks/'+task.id+'/approvals',{
      method:'POST',headers:server.auth,body:JSON.stringify({...approvalBody,client_request_id:'req-2'})
    });
    assert.equal(repeat.status,200);
    assert.equal(repeat.body.operation.id,approved.body.operation.id);
    const executeJobs=store.db.prepare("SELECT * FROM jobs WHERE type='execute_operation'").all();
    assert.equal(executeJobs.length,1);
    const other=tasks.create({
      todoId:null,requestKey:'message:2:'+target,kind:'doc_fill',executorType:'tencent_sheet',
      accountRef:'9999',targetRef:target,createdAt:now
    });
    const forbidden=await server.call('/v1/tasks/'+other.id,{headers:server.auth});
    assert.equal(forbidden.status,403);
  }finally{
    await server.close();
    store.db.close();
  }
});
