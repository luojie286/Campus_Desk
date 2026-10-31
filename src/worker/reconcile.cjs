// 结果未知任务的只读核对 worker：读取表格，确认计划中的值是否已经写入。
// 核对绝不调用 applyGeneral 或任何写入方法；只有全部一致才把任务标记完成。
const {changesMatch,text}=require('../core.cjs');
const {loginRequired}=require('../documents/login.cjs');
const {column}=require('../tencent.cjs');

// 生成可脱敏保存的核对证据：只保留单元格地址、字段名和计数，不保存单元格原值或拟填值。
function summarizeChanges(plan,grid,now){
  const changes=Array.isArray(plan.changes)?plan.changes:[];
  const mismatches=[];
  let matched=0;
  for(const change of changes){
    const row=Number(change.row),col=Number(change.col);
    const actual=text(grid[row-1]?.[col-1]);
    if(actual===text(change.value))matched++;
    else mismatches.push({cell:column(col)+row,field:change.field||null});
  }
  return {
    reconciled:matched===changes.length,
    matched,
    total:changes.length,
    mismatches:mismatches.slice(0,20),
    checked_at:now
  };
}

// 无法核对的数据完整性问题：记录证据后把任务终止，避免永久停在 outcome_unknown。
function failTerminal(tasks,{task,operation,errorClass,evidence,now}){
  if(operation){
    tasks.failOperation({
      operationId:operation.id,
      state:'unknown',
      errorClass,
      evidence,
      expectedState:'unknown',
      now
    });
  }
  return tasks.transition({id:task.id,accountRef:task.account_ref,event:'fail_terminal',now});
}

async function processNextReconcileJob({
  tasks,
  jobs,
  config,
  workerId,
  now=new Date().toISOString(),
  createSheet
}){
  const job=jobs.claim({workerId,leaseSeconds:300,now,type:'reconcile_task'});
  if(!job)return {processed:false};
  let task=null,operation=null,lockKey=null,locked=false,sheet=null;
  const ownerId=workerId+':'+job.id;
  try{
    const payload=JSON.parse(job.payload_json||'{}');
    const taskId=Number(payload.taskId);
    const accountRef=payload.accountRef;
    if(!Number.isInteger(taskId)||!accountRef)throw Error('task_reference_invalid');

    // tasks.get 同时校验账号；不使用 getAny，避免跨账号核对。
    task=tasks.get({id:taskId,accountRef});
    if(!task){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,error:'task_not_found'};
    }
    // 任务已被其他入口处理或已取消时，陈旧的核对 job 直接结束。
    if(task.state!=='outcome_unknown'){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,skipped:true,state:task.state};
    }

    operation=payload.operationId
      ? tasks.getOperation({id:Number(payload.operationId),taskId})
      : tasks.latestOperation({taskId,accountRef});
    if(!operation){
      task=failTerminal(tasks,{
        task,
        operation:null,
        errorClass:'operation_not_found',
        evidence:{stage:'operation_not_found',checked_at:now},
        now
      });
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:task.state,error:'operation_not_found'};
    }
    if(operation.state!=='unknown'){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,skipped:true,state:task.state,error:'operation_not_reconcilable'};
    }

    // 必须使用 operation 实际关联的计划；current_plan_id 可能已经指向别的版本。
    const planRow=tasks.getPlan({id:operation.plan_id,accountRef});
    if(!planRow||Number(planRow.task_id)!==Number(task.id)){
      task=failTerminal(tasks,{
        task,
        operation,
        errorClass:'plan_not_found',
        evidence:{stage:'plan_not_found',checked_at:now},
        now
      });
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:task.state,error:'plan_not_found'};
    }

    let plan=null;
    try{plan=JSON.parse(planRow.plan_json);}catch{}
    // changesMatch 对空数组会返回 true；这里必须先排除“没有计划内容”的情况。
    if(!plan||!Array.isArray(plan.changes)||plan.changes.length===0){
      task=failTerminal(tasks,{
        task,
        operation,
        errorClass:'plan_invalid',
        evidence:{stage:'plan_invalid',checked_at:now},
        now
      });
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:task.state,error:'plan_invalid'};
    }

    // 与 execute 共用同一把文档锁，保证核对期间不会有写入。
    lockKey=String(task.target_ref);
    if(!tasks.acquireLock({lockKey,ownerId,taskId:task.id,operationId:operation.id,ttlSeconds:300,now})){
      jobs.fail(job.id,'document_busy',{retryDelaySeconds:15,now});
      return {processed:true,jobId:job.id,error:'document_busy'};
    }
    locked=true;

    sheet=createSheet(config);
    await sheet.open(task.target_ref);
    if(await loginRequired(sheet)){
      // 登录失效不是可自动恢复的错误：记录类别后结束，用户登录完再点一次核对。
      tasks.failOperation({
        operationId:operation.id,
        state:'unknown',
        errorClass:'login_required',
        evidence:{stage:'login_required',checked_at:now},
        expectedState:'unknown',
        now
      });
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:task.state,error:'login_required'};
    }

    const grid=await sheet.readUsedRange();
    const matched=changesMatch(plan,grid);
    const evidence=summarizeChanges(plan,grid,now);
    evidence.reconciled=matched;

    if(matched){
      // 顺序：先进入 verifying，再条件完成 operation，最后进入 completed。
      // completeOperation 带 expectedState，避免覆盖另一个核对 worker 已经写下的结论。
      tasks.transition({id:task.id,accountRef,event:'reconcile',now});
      const completedOperation=tasks.completeOperation({
        operationId:operation.id,
        evidence,
        expectedState:'unknown',
        now
      });
      if(!completedOperation){
        const currentOperation=tasks.getOperation({id:operation.id,taskId});
        if(!currentOperation||currentOperation.state!=='completed'){
          // 无法证明这次核对胜出：退回结果未知，不覆盖已有证据。
          const back=tasks.transition({id:task.id,accountRef,event:'unknown',now});
          jobs.complete(job.id,now);
          return {processed:true,jobId:job.id,state:back.state,error:'operation_state_conflict'};
        }
      }
      task=tasks.transition({id:task.id,accountRef,event:'verified',now});
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:task.state};
    }

    // 核对不一致：只记录证据，任务保持 outcome_unknown，绝不自动重写。
    const updated=tasks.failOperation({
      operationId:operation.id,
      state:'unknown',
      errorClass:'manual_reconciliation_required',
      evidence:{...evidence,previous_error_class:operation.error_class||null},
      expectedState:'unknown',
      now
    });
    jobs.complete(job.id,now);
    return {
      processed:true,
      jobId:job.id,
      state:task.state,
      error:updated?'manual_reconciliation_required':'operation_state_conflict'
    };
  }catch(error){
    const message=String(error.message||error).split('\n')[0].slice(0,200);
    // 如果已经进入 verifying 但后续步骤失败，按 operation 的实际状态收尾：
    // operation 已完成则补做 verified；仍未知则退回 outcome_unknown，避免卡在中间态。
    if(task){
      const current=tasks.get({id:task.id,accountRef:task.account_ref});
      if(current&&current.state==='verifying'){
        const currentOperation=operation
          ? tasks.getOperation({id:operation.id,taskId:task.id})
          : null;
        try{
          tasks.transition({
            id:current.id,
            accountRef:current.account_ref,
            event:currentOperation&&currentOperation.state==='completed'?'verified':'unknown',
            now
          });
        }catch{}
      }
    }
    // 登录、状态冲突等错误重试没有意义；其余错误交给 job 延迟重试。
    const nonRetryable=['login_required','document_login_window_open_close_it_first',
      'browser_profile_outside_private_directory','unsupported_document',
      'task_state_conflict'];
    if(operation&&message==='login_required'){
      try{
        tasks.failOperation({
          operationId:operation.id,
          state:'unknown',
          errorClass:'login_required',
          evidence:{stage:'login_required',checked_at:now},
          expectedState:'unknown',
          now
        });
      }catch{}
    }
    if(nonRetryable.includes(message)||message.startsWith('invalid_transition_')){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,error:message};
    }
    jobs.fail(job.id,message,{retryDelaySeconds:30,now});
    return {processed:true,jobId:job.id,error:message};
  }finally{
    if(sheet){try{await sheet.close();}catch{}}
    if(locked){try{tasks.releaseLock({lockKey,ownerId});}catch{}}
  }
}

module.exports={processNextReconcileJob,summarizeChanges};
