const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createTaskRepository}=require('../src/db/repositories/tasks.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');
const {processNextPrepareJob}=require('../src/worker/prepare.cjs');
const {assertWritePreconditions}=require('../src/core.cjs');

const now='2026-10-30T08:00:00.000Z';
const target='https://docs.qq.com/sheet/abc';
const grid=[
  ['姓名','学号','性别','专业'],
  ['示例学生','202500000000','','计算机科学与技术']
];
const mappings=[
  {column:1,field:'name'},
  {column:2,field:'student_id'},
  {column:3,field:'sex'},
  {column:4,field:'major'}
];
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
function fakeSheet(){
  return {
    opened:false,
    async open(){this.opened=true;},
    async readUsedRange(){return grid;},
    async isEditable(){return true;},
    async close(){this.opened=false;}
  };
}
test('prepare: creates a plan and waits for approval without writing',async()=>{
  const {store,tasks,jobs,task}=setup();
  const sheet=fakeSheet();
  jobs.enqueue({type:'prepare_task',payload:{taskId:task.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const result=await processNextPrepareJob({
    tasks,jobs,config:{},workerId:'w1',now,
    fields:()=>({name:'示例学生',student_id:'202500000000',sex:'男',major:'计算机科学与技术'}),
    reservationFor:()=>null,
    createSheet:()=>sheet,
    analyze:async()=>({mappings,confidence:0.95,notes:''})
  });
  assert.equal(result.processed,true);
  assert.equal(result.state,'awaiting_approval');
  const current=tasks.get({id:task.id,accountRef:'7007'});
  assert.equal(current.state,'awaiting_approval');
  const plan=tasks.currentPlan({taskId:task.id,accountRef:'7007'});
  const body=JSON.parse(plan.plan_json);
  assert.equal(body.changes.length,1);
  assert.equal(body.changes[0].field,'sex');
  assert.equal(body.changes[0].value,'男');
  assert.equal(sheet.opened,false);
  store.db.close();
});
test('prepare: matches an existing row by student id when the name cell is empty',async()=>{
  const {store,tasks,jobs,task}=setup();
  const idGrid=[
    ['姓名','学号','性别','专业'],
    ['','202500000000','','']
  ];
  jobs.enqueue({type:'prepare_task',payload:{taskId:task.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const result=await processNextPrepareJob({
    tasks,jobs,config:{},workerId:'w1',now,
    fields:()=>({name:'示例学生',student_id:'202500000000',sex:'男',major:'计算机科学与技术'}),
    reservationFor:()=>null,
    createSheet:()=>({
      async open(){},
      async readUsedRange(){return idGrid;},
      async isEditable(){return true;},
      async close(){}
    }),
    analyze:async()=>({mappings,confidence:0.95,notes:''})
  });
  assert.equal(result.processed,true);
  assert.equal(result.state,'awaiting_approval');
  const plan=tasks.currentPlan({taskId:task.id,accountRef:'7007'});
  const body=JSON.parse(plan.plan_json);
  assert.equal(body.identityMode,'student_id_only');
  assert.equal(body.identityRow,2);
  assert.deepEqual(body.changes.map(change=>change.field).sort(),['major','name','sex']);
  assert.doesNotThrow(()=>assertWritePreconditions(body,idGrid,{name:'示例学生',student_id:'202500000000'}));
  store.db.close();
});
test('prepare: no existing identity creates a new-row plan and does not write',async()=>{
  const {store,tasks,jobs,task}=setup();
  const otherGrid=[
    ['姓名','学号','性别','专业'],
    ['其他同学','202500000001','男','物理学']
  ];
  jobs.enqueue({type:'prepare_task',payload:{taskId:task.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const result=await processNextPrepareJob({
    tasks,jobs,config:{},workerId:'w1',now,
    fields:()=>({name:'示例学生',student_id:'202500000000',sex:'男',major:'计算机科学与技术'}),
    reservationFor:()=>null,
    createSheet:()=>({
      async open(){},
      async readUsedRange(){return otherGrid;},
      async isEditable(){return true;},
      async close(){}
    }),
    analyze:async()=>({mappings,confidence:0.95,notes:''})
  });
  assert.equal(result.processed,true);
  assert.equal(result.state,'awaiting_approval');
  const plan=tasks.currentPlan({taskId:task.id,accountRef:'7007'});
  const body=JSON.parse(plan.plan_json);
  assert.equal(body.identityMode,'new_row');
  assert.equal(body.identityRow,3);
  assert.equal(body.changes.length,4);
  assert.deepEqual(body.changes.map(change=>change.field).sort(),['major','name','sex','student_id']);
  assert.doesNotThrow(()=>assertWritePreconditions(body,otherGrid,{name:'示例学生',student_id:'202500000000'}));
  const occupied=[...otherGrid,['','','','']];
  occupied[2]=['已经有人','202500000002','男','数学'];
  assert.throws(()=>assertWritePreconditions(body,occupied,{name:'示例学生',student_id:'202500000000'}),/target_row_(changed|not_empty)/);
  store.db.close();
});
test('prepare: missing profile values become questions and wait for input',async()=>{
  const {store,tasks,jobs,task}=setup();
  jobs.enqueue({type:'prepare_task',payload:{taskId:task.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const result=await processNextPrepareJob({
    tasks,jobs,config:{},workerId:'w1',now,
    fields:()=>({name:'示例学生',student_id:'202500000000',sex:'',major:'计算机科学与技术'}),
    reservationFor:()=>null,
    createSheet:()=>fakeSheet(),
    analyze:async()=>({mappings,confidence:0.9,notes:''})
  });
  assert.equal(result.processed,true);
  assert.equal(result.state,'awaiting_input');
  const current=tasks.get({id:task.id,accountRef:'7007'});
  const questions=tasks.questions({taskId:task.id,taskVersion:current.state_version});
  assert.equal(questions.length,1);
  assert.equal(questions[0].key,'sex');
  assert.equal(questions[0].reason,'profile_value_missing');
  assert.equal(jobs.claim({workerId:'w2',type:'prepare_task',now}),null);
  store.db.close();
});
