// 只读查看某个文档填写任务的计划、审批、操作和队列记录。
// 不读取 profile、令牌或浏览器会话；输出只包含任务本身和错误类别。
const {DatabaseSync}=require('node:sqlite');

function parse(value,fallback=null){
  if(value===null||value===undefined||value==='')return fallback;
  try{return JSON.parse(value);}catch{return fallback;}
}

// 日志默认只显示“哪个单元格、哪个字段”，不显示姓名/学号等拟填值。
// 需要核对具体值时，用户必须显式加 --values。
function safePlan(plan,showValues){
  if(!plan||typeof plan!=='object')return plan;
  const copy={...plan};
  if(Array.isArray(copy.changes)){
    copy.changes=copy.changes.map(change=>({
      row:change.row,
      col:change.col,
      field:change.field,
      before:showValues?change.before:(change.before?'[非空]':''),
      value:showValues?change.value:'[已隐藏]',
      replaces_placeholder:change.replaces_placeholder
    }));
  }
  return copy;
}

function safeEvidence(evidence,showValues){
  if(!evidence||typeof evidence!=='object')return evidence;
  return safePlan(evidence,showValues);
}

function main(){
  const dbPath=process.env.POC_DB||'.private/poc.sqlite';
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const args=process.argv.slice(2);
    const showValues=args.includes('--values');
    const legacy=args.includes('--legacy');
    const idArg=args.find(item=>!item.startsWith('--'));
    if(legacy){
      // 旧 pipeline 的 AI 填表记录在 runs 表，不在新 tasks 表。
      const runs=db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 20').all()
        .map(row=>({
          id:row.id,
          state:row.state,
          source_key:showValues?row.source_key:'[已隐藏]',
          url:row.url,
          error:row.error,
          updated_at:row.updated_at,
          plan:safePlan(parse(row.plan,null),showValues)
        }));
      console.log(JSON.stringify({
        legacyRuns:runs,
        values_visible:showValues,
        note:showValues
          ? '警告：--values 会显示真实拟填值，请勿公开分享这段输出。'
          : '这是旧 pipeline 的 runs 记录；拟填值默认隐藏，需要核对时再加 --values。'
      },null,2));
      return;
    }
    let task;
    if(idArg){
      const taskId=Number(idArg);
      if(!Number.isInteger(taskId)||taskId<1){
        console.error('用法: node tools/show-task-log.cjs <taskId> | --latest | --legacy [--values]');
        process.exitCode=1;
        return;
      }
      task=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    }else{
      task=db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 1').get();
    }
    if(!task){
      console.log(JSON.stringify({
        task:null,
        task_id:idArg?Number(idArg):null,
        message:'没有找到文档填写任务',
        hint:'如果查看的是旧 pipeline 的填表记录，请运行 npm run logs -- --legacy'
      },null,2));
      return;
    }

    const plans=db.prepare('SELECT * FROM plans WHERE task_id=? ORDER BY version').all(task.id)
      .map(row=>({
        id:row.id,
        version:row.version,
        status:row.status,
        digest:row.digest,
        created_at:row.created_at,
        plan:safePlan(parse(row.plan_json,{}),showValues)
      }));
    const approvals=db.prepare('SELECT * FROM approvals WHERE task_id=? ORDER BY id').all(task.id)
      .map(row=>({
        id:row.id,
        plan_id:row.plan_id,
        plan_version:row.plan_version,
        decision:row.decision,
        client_request_id:row.client_request_id,
        created_at:row.created_at,
        consumed_at:row.consumed_at
      }));
    const operations=db.prepare('SELECT * FROM operations WHERE task_id=? ORDER BY id').all(task.id)
      .map(row=>({
        id:row.id,
        plan_id:row.plan_id,
        kind:row.kind,
        state:row.state,
        attempt:row.attempt,
        started_at:row.started_at,
        finished_at:row.finished_at,
        error_class:row.error_class,
        evidence:safeEvidence(parse(row.evidence_json,null),showValues)
      }));
    const operationIds=new Set(operations.map(item=>item.id));
    const jobs=db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 200').all()
      .filter(row=>{
        const payload=parse(row.payload_json,{});
        return payload.taskId===task.id||operationIds.has(Number(payload.operationId));
      })
      .map(row=>({
        id:row.id,
        type:row.type,
        state:row.state,
        attempts:row.attempts,
        max_attempts:row.max_attempts,
        last_error:row.last_error,
        run_at:row.run_at,
        updated_at:row.updated_at
      }));

    console.log(JSON.stringify({
      task:{
        id:task.id,
        state:task.state,
        state_version:task.state_version,
        waiting_reason:task.waiting_reason,
        target_ref:task.target_ref,
        created_at:task.created_at,
        updated_at:task.updated_at,
        completed_at:task.completed_at,
        metadata:parse(task.metadata_json,{})
      },
      plans,
      approvals,
      operations,
      jobs,
      values_visible:showValues,
      note:showValues
        ? '警告：--values 会显示真实拟填值，请勿公开分享这段输出。'
        : '这是操作级记录；拟填值默认隐藏，需要核对时再加 --values。错误类别在 error_class/last_error。'
    },null,2));
  }finally{
    db.close();
  }
}

main();
