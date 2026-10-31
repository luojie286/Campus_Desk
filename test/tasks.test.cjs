const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createTaskRepository}=require('../src/db/repositories/tasks.cjs');

const now='2026-10-30T07:00:00.000Z';
const link='https://docs.qq.com/sheet/abc?tab=BB08J2';
function setup(){
  const store=openStore(':memory:');
  applyMigrations(store.db);
  return {store,tasks:createTaskRepository(store.db)};
}
function createDocTask(tasks){
  return tasks.create({
    todoId:null,
    requestKey:'message:1:'+link,
    kind:'doc_fill',
    executorType:'tencent_sheet',
    accountRef:'7007',
    targetRef:link,
    metadata:{messageId:1},
    createdAt:now
  });
}
test('tasks: direct doc task creation dedupes by request key and transitions explicitly',()=>{
  const {store,tasks}=setup();
  const task=createDocTask(tasks);
  assert.equal(task.created,true);
  assert.equal(task.target_ref,link);
  assert.equal(task.state,'created');
  assert.equal(task.todo_id,null);
  const duplicate=createDocTask(tasks);
  assert.equal(duplicate.id,task.id);
  assert.equal(duplicate.created,false);
  let updated=tasks.transition({id:task.id,accountRef:'7007',event:'start',now});
  assert.equal(updated.state,'preparing');
  assert.equal(updated.state_version,2);
  updated=tasks.transition({id:task.id,accountRef:'7007',event:'need_input',now});
  assert.equal(updated.state,'awaiting_input');
  tasks.setQuestions({taskId:task.id,taskVersion:updated.state_version,questions:[{key:'major',label:'专业',kind:'text',reason:'profile_value_missing'}],createdAt:now});
  assert.equal(tasks.questions({taskId:task.id,taskVersion:updated.state_version}).length,1);
  tasks.saveAnswers({taskId:task.id,taskVersion:updated.state_version,answers:[{key:'major',value:'计算机科学与技术',scope:'task'}],answeredAt:now});
  assert.equal(tasks.answers({taskId:task.id,taskVersion:updated.state_version})[0].value,'计算机科学与技术');
  updated=tasks.transition({id:task.id,accountRef:'7007',event:'answer',now});
  assert.equal(updated.state,'preparing');
  updated=tasks.transition({id:task.id,accountRef:'7007',event:'ready_for_approval',now});
  assert.equal(updated.state,'awaiting_approval');
  assert.throws(()=>tasks.transition({id:task.id,accountRef:'9999',event:'approve',now}),/task_not_found/);
  assert.throws(()=>tasks.transition({id:task.id,accountRef:'7007',event:'verified',now}),/invalid_transition/);
  store.db.close();
});
test('tasks: latest operation is account-scoped and conditional updates preserve a final result',()=>{
  const {store,tasks}=setup();
  const task=createDocTask(tasks);
  tasks.transition({id:task.id,accountRef:'7007',event:'start',now});
  tasks.transition({id:task.id,accountRef:'7007',event:'ready_for_approval',now});
  const saved=tasks.savePlan({taskId:task.id,plan:{changes:[{row:2,col:2,field:'major',value:'x'}]},digest:'d1',createdAt:now});
  const approved=tasks.createApproval({
    taskId:task.id,planId:saved.id,planVersion:saved.version,planDigest:saved.digest,
    clientRequestId:'req-1',createdAt:now
  });
  const operationId=approved.operation.id;
  assert.equal(tasks.latestOperation({taskId:task.id,accountRef:'7007'}).id,operationId);
  assert.equal(tasks.latestOperation({taskId:task.id,accountRef:'9999'}),null);

  // 条件不满足时不更新，避免并发核对覆盖最终结果。
  assert.equal(tasks.completeOperation({operationId,evidence:{x:1},expectedState:'unknown',now}),null);
  tasks.failOperation({operationId,state:'unknown',errorClass:'readback_mismatch',now});
  const done=tasks.completeOperation({operationId,evidence:{reconciled:true},expectedState:'unknown',now});
  assert.equal(done.state,'completed');
  assert.equal(done.error_class,null);
  assert.equal(tasks.completeOperation({operationId,evidence:{reconciled:false},expectedState:'unknown',now}),null);
  assert.equal(JSON.parse(tasks.getOperation({id:operationId,taskId:task.id}).evidence_json).reconciled,true);
  store.db.close();
});

test('tasks: plan versions, approval operations and document locks are serialized',()=>{
  const {store,tasks}=setup();
  const task=createDocTask(tasks);
  tasks.transition({id:task.id,accountRef:'7007',event:'start',now});
  tasks.transition({id:task.id,accountRef:'7007',event:'ready_for_approval',now});
  const p1=tasks.savePlan({taskId:task.id,plan:{changes:[{row:2,col:2,field:'major',value:'x'}]},digest:'d1',createdAt:now});
  const p2=tasks.savePlan({taskId:task.id,plan:{changes:[{row:2,col:2,field:'major',value:'y'}]},digest:'d2',createdAt:now});
  assert.equal(p1.version,1);
  assert.equal(p2.version,2);
  assert.equal(tasks.currentPlan({taskId:task.id,accountRef:'7007'}).version,2);
  assert.equal(store.db.prepare('SELECT status FROM plans WHERE id=?').get(p1.id).status,'superseded');
  const first=tasks.createApproval({taskId:task.id,planId:p2.id,planVersion:p2.version,planDigest:p2.digest,clientRequestId:'req-1',actorDeviceId:'dev1',createdAt:now});
  const repeat=tasks.createApproval({taskId:task.id,planId:p2.id,planVersion:p2.version,planDigest:p2.digest,clientRequestId:'req-2',actorDeviceId:'dev1',createdAt:now});
  assert.equal(first.operation.state,'queued');
  assert.equal(repeat.operation.id,first.operation.id);
  assert.equal(tasks.getOperation({id:first.operation.id,taskId:task.id}).kind,'fill');
  assert.equal(tasks.acquireLock({lockKey:'doc:abc',ownerId:'w1',taskId:task.id,ttlSeconds:60,now}),true);
  assert.equal(tasks.acquireLock({lockKey:'doc:abc',ownerId:'w2',taskId:task.id,ttlSeconds:60,now}),false);
  assert.equal(tasks.releaseLock({lockKey:'doc:abc',ownerId:'w1'}),true);
  assert.equal(tasks.acquireLock({lockKey:'doc:abc',ownerId:'w2',taskId:task.id,ttlSeconds:60,now}),true);
  const late=new Date(new Date(now).getTime()+120000).toISOString();
  assert.equal(tasks.acquireLock({lockKey:'doc:abc',ownerId:'w3',taskId:task.id,ttlSeconds:60,now:late}),true);
  store.db.close();
});
