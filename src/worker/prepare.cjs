// 文档任务准备 worker：只读打开表格、定位身份、调用表格映射模型并生成计划。
// 成功时进入 awaiting_input 或 awaiting_approval；这里绝不写单元格，写入由审批后的执行 worker 负责。
const {buildGeneralPlan,digest}=require('../core.cjs');
const {prepareColumnAnalysis}=require('../llm.cjs');
const {resolveIdentity,resolveNewRowIdentity}=require('../documents/identity.cjs');
const {loginRequired}=require('../documents/login.cjs');
const profiles=require('../documents/profile.cjs');

function questionsFromMissing(missing){
  const seen=new Set(),questions=[];
  for(const item of missing||[]){
    if(seen.has(item.field))continue;
    seen.add(item.field);
    questions.push({
      key:item.field,
      label:item.header||item.field,
      kind:'text',
      reason:item.reason||'profile_value_missing'
    });
  }
  return questions;
}

async function processNextPrepareJob({
  tasks,
  jobs,
  config,
  workerId,
  now=new Date().toISOString(),
  fields,
  allowedTask=()=>true,
  reservationFor=()=>null,
  createSheet,
  analyze
}){
  const job=jobs.claim({workerId,leaseSeconds:120,now,type:'prepare_task'});
  if(!job)return {processed:false};
  let task=null;
  try{
    const payload=JSON.parse(job.payload_json||'{}');
    const taskId=Number(payload.taskId);
    const accountRef=payload.accountRef;
    if(!Number.isInteger(taskId)||!accountRef)throw Error('task_reference_invalid');
    task=tasks.get({id:taskId,accountRef});
    if(!task)throw Error('task_not_found');
    if(!allowedTask(task)){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,skipped:true,error:'outside_scope'};
    }
    if(task.state==='created')task=tasks.transition({id:task.id,accountRef,event:'start',now});
    else if(task.state==='failed_retryable')task=tasks.transition({id:task.id,accountRef,event:'retry',now});
    if(task.state!=='preparing')throw Error('task_not_preparing');

    // 任务级回答覆盖本地资料，但只覆盖已经存在的字段 key。
    const values=fields();
    const answers=tasks.latestAnswers({taskId:task.id});
    const profile=profiles.effective(values,answers);

    const sheet=createSheet(config);
    try{
      await sheet.open(task.target_ref);
      if(await loginRequired(sheet)){
        const paused=tasks.transition({id:task.id,accountRef,event:'pause_login',now});
        jobs.complete(job.id,now);
        return {processed:true,jobId:job.id,state:paused.state,paused:true};
      }
      const grid=await sheet.readUsedRange();
      const resolved=resolveIdentity(grid,profile,reservationFor(task.target_ref))||resolveNewRowIdentity(grid);
      if(!resolved)throw Error('identity_not_found');

      const analysisPayload=prepareColumnAnalysis({
        grid,
        identity:resolved.identity,
        headerRow:resolved.headerRow,
        fields:profile
      });
      const analysis=await analyze({payload:analysisPayload,config});
      const plan=buildGeneralPlan({
        grid,
        identity:resolved.identity,
        headerRow:resolved.headerRow,
        mappings:analysis.mappings,
        fields:profile
      });
      const storedPlan={...plan,confidence:analysis.confidence,notes:analysis.notes,document:task.target_ref};
      storedPlan.profileFingerprint=profiles.fingerprint(storedPlan,values,answers);
      if(!profiles.planCurrent(storedPlan,fields(),tasks.latestAnswers({taskId:task.id}),true))throw Error('profile_changed');
      const saved=tasks.savePlan({
        taskId:task.id,
        plan:storedPlan,
        digest:digest(storedPlan),
        createdAt:now
      });

      if(plan.missing.length){
        const waiting=tasks.transition({id:task.id,accountRef,event:'need_input',now});
        tasks.setQuestions({
          taskId:task.id,
          taskVersion:waiting.state_version,
          questions:questionsFromMissing(plan.missing),
          createdAt:now
        });
        jobs.complete(job.id,now);
        return {processed:true,jobId:job.id,state:waiting.state,planId:saved.id};
      }
      if(!plan.changes.length){
        const done=tasks.transition({id:task.id,accountRef,event:'no_changes',now});
        jobs.complete(job.id,now);
        return {processed:true,jobId:job.id,state:done.state,planId:saved.id,noChanges:true};
      }
      const waiting=tasks.transition({id:task.id,accountRef,event:'ready_for_approval',now});
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:waiting.state,planId:saved.id,planVersion:saved.version};
    }finally{
      await sheet.close();
    }
  }catch(error){
    const message=String(error.message||error).split('\n')[0].slice(0,200);
    if(task){
      const current=tasks.get({id:task.id,accountRef:task.account_ref});
      if(current&&current.state==='preparing'){
        try{tasks.transition({id:current.id,accountRef:current.account_ref,event:'fail_retryable',now});}
        catch{}
      }
    }
    jobs.fail(job.id,message,{now});
    return {processed:true,jobId:job.id,error:message};
  }
}

module.exports={processNextPrepareJob,questionsFromMissing};
