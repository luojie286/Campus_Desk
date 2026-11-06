// 审批后的执行 worker：文档锁 -> 重新核对 -> 写入 -> 独立回读。
// 写入一旦开始，任何异常都进入 outcome_unknown；绝不能靠自动重试再写一次。
const {assertWritePreconditions}=require('../core.cjs');
const {loginRequired}=require('../documents/login.cjs');

async function processNextExecuteJob({
  tasks,
  jobs,
  config,
  workerId,
  now=new Date().toISOString(),
  fields,
  allowedTask=()=>true,
  createSheet
}){
  const job=jobs.claim({workerId,leaseSeconds:300,now,type:'execute_operation'});
  if(!job)return {processed:false};
  let task=null,operation=null,lockKey=null,locked=false,writeAttempted=false,sheet=null;
  const ownerId=workerId+':'+job.id;
  try{
    const payload=JSON.parse(job.payload_json||'{}');
    const taskId=Number(payload.taskId);
    const accountRef=payload.accountRef;
    const operationId=Number(payload.operationId);
    if(!Number.isInteger(taskId)||!Number.isInteger(operationId)||!accountRef)throw Error('task_reference_invalid');
    task=tasks.get({id:taskId,accountRef});
    if(!task)throw Error('task_not_found');
    if(!allowedTask(task)){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,skipped:true,error:'outside_scope'};
    }
    // 已取消/已完成的任务不执行；陈旧 job 直接结束。
    if(task.state!=='approved'){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,skipped:true,state:task.state};
    }
    operation=tasks.getOperation({id:operationId,taskId:task.id});
    if(!operation)throw Error('operation_not_found');
    if(operation.state==='completed'||operation.state==='unknown'){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,skipped:true,state:task.state};
    }
    // 审批后配置可能被关闭；执行器必须再次检查开关，不能只依赖 API。
    if(config.execute!==true){
      tasks.failOperation({operationId:operation.id,state:'failed_retryable',errorClass:'execute_disabled',now});
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,skipped:true,state:task.state,error:'execute_disabled'};
    }
    lockKey=String(task.target_ref);
    if(!tasks.acquireLock({lockKey,ownerId,taskId:task.id,operationId:operation.id,ttlSeconds:300,now})){
      jobs.fail(job.id,'document_busy',{retryDelaySeconds:15,now});
      return {processed:true,jobId:job.id,error:'document_busy'};
    }
    locked=true;
    const execution=tasks.dispatchApproved({taskId,accountRef,operationId,fields,now});
    if(!execution){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,skipped:true,state:tasks.get({id:taskId,accountRef})?.state};
    }
    const {plan,profile}=execution;
    task=tasks.get({id:taskId,accountRef});

    sheet=createSheet(config);
    await sheet.open(task.target_ref);
    if(await loginRequired(sheet))throw Error('login_required');
    const grid=await sheet.readUsedRange();
    // 写入前再次核对身份和目标单元格，防止审批后表格被别人改动。
    assertWritePreconditions(plan,grid,profile);
    writeAttempted=true;
    await sheet.applyGeneral(plan,profile);
    task=tasks.transition({id:task.id,accountRef,event:'verify',now});
    if(!await sheet.verifyGeneral(plan)){
      task=tasks.transition({id:task.id,accountRef,event:'unknown',now});
      tasks.failOperation({operationId:operation.id,state:'unknown',errorClass:'readback_mismatch',now});
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:task.state,error:'readback_mismatch'};
    }
    task=tasks.transition({id:task.id,accountRef,event:'verified',now});
    tasks.completeOperation({operationId:operation.id,evidence:{changes:plan.changes},now});
    jobs.complete(job.id,now);
    return {processed:true,jobId:job.id,state:task.state};
  }catch(error){
    const message=String(error.message||error).split('\n')[0].slice(0,200);
    if(writeAttempted){
      // 已经调用过写入：只记录未知，不再重试。
      try{task=tasks.transition({id:task.id,accountRef:task.account_ref,event:'unknown',now});}catch{}
      try{tasks.failOperation({operationId:operation.id,state:'unknown',errorClass:message,now});}catch{}
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:'outcome_unknown',error:message};
    }
    if(operation){
      try{tasks.failOperation({operationId:operation.id,state:'failed_retryable',errorClass:message,now});}catch{}
    }
    if(task){
      const current=tasks.get({id:task.id,accountRef:task.account_ref});
      if(current&&current.state==='executing'){
        // 尚未写入；可以安全地标为可重试，但当前不自动重新审批。
        try{tasks.transition({id:current.id,accountRef:current.account_ref,event:'fail_retryable',now});}catch{}
        jobs.complete(job.id,now);
        return {processed:true,jobId:job.id,state:'failed_retryable',error:message};
      }
    }
    jobs.fail(job.id,message,{now});
    return {processed:true,jobId:job.id,error:message};
  }finally{
    if(sheet){try{await sheet.close();}catch{}}
    if(locked){try{tasks.releaseLock({lockKey,ownerId});}catch{}}
  }
}

module.exports={processNextExecuteJob};
