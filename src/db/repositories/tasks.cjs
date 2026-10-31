// 任务仓储：正式待办派生文档任务、显式状态转移、问题/回答、计划版本、审批操作和文档锁。
// 外部浏览器操作不在这里执行；这里只保证数据库状态和幂等约束。
const {transition}=require('../../tasks/state.cjs');

function createTaskRepository(db){
  const nowIso=()=>new Date().toISOString();
  const getTask=({id,accountRef})=>db.prepare('SELECT * FROM tasks WHERE id=? AND account_ref=?')
    .get(Number(id),String(accountRef))||null;
  const jsonText=value=>value===undefined||value===null?null:(typeof value==='string'?value:JSON.stringify(value));
  return {
    create({todoId=null,requestKey=null,kind='doc_fill',executorType='tencent_sheet',accountRef,targetRef,metadata=null,createdAt=nowIso()}){
      // 文档链接任务没有 todo；用 request_key（账号+消息+文档）去重。
      const existing=requestKey
        ? db.prepare('SELECT * FROM tasks WHERE account_ref=? AND request_key=?').get(String(accountRef),String(requestKey))
        : (todoId===null?null:db.prepare('SELECT * FROM tasks WHERE todo_id=? AND target_ref=? AND kind=?')
          .get(Number(todoId),String(targetRef),String(kind)));
      if(existing)return {...existing,created:false};
      const info=db.prepare(`INSERT INTO tasks
        (todo_id,request_key,kind,executor_type,account_ref,target_ref,state,state_version,created_at,updated_at,metadata_json)
        VALUES(?,?,?,?,?,?,'created',1,?,?,?)`)
        .run(todoId===null?null:Number(todoId),requestKey===null?null:String(requestKey),
          String(kind),String(executorType),String(accountRef),String(targetRef),
          createdAt,createdAt,jsonText(metadata));
      return {...db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(info.lastInsertRowid)),created:true};
    },
    get({id,accountRef}){return getTask({id,accountRef});},
    // 仅供 API 判断“任务存在但不属于当前账号”，用于返回 403 而不是把存在性伪装成 404。
    getAny({id}){return db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(id))||null;},
    list({accountRef,state=null,limit=100}){
      const params=[String(accountRef)];let where='account_ref=?';
      if(state){where+=' AND state=?';params.push(String(state));}
      return db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT ?`)
        .all(...params,Math.min(Math.max(Number(limit)||100,1),200));
    },
    transition({id,accountRef,event,now=nowIso()}){
      const task=getTask({id,accountRef});
      if(!task)throw Error('task_not_found');
      const next=transition(task.state,event);
      const terminal=['completed','cancelled','failed_terminal'].includes(next);
      const updated=db.prepare(`UPDATE tasks SET state=?,state_version=state_version+1,
        updated_at=?,waiting_reason=NULL,completed_at=? WHERE id=? AND state=? AND state_version=?`)
        .run(next,now,terminal?now:task.completed_at,Number(id),task.state,task.state_version);
      if(updated.changes!==1)throw Error('task_state_conflict');
      return getTask({id,accountRef});
    },
    setQuestions({taskId,taskVersion,questions,createdAt=nowIso()}){
      db.prepare('DELETE FROM task_questions WHERE task_id=? AND task_version=?')
        .run(Number(taskId),Number(taskVersion));
      for(const question of questions||[]){
        db.prepare(`INSERT INTO task_questions
          (task_id,task_version,key,label,kind,options_json,reason,source_ref,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(Number(taskId),Number(taskVersion),String(question.key),String(question.label||question.key),
            String(question.kind||'text'),jsonText(question.options),question.reason||null,
            question.sourceRef||null,createdAt);
      }
      return (questions||[]).length;
    },
    questions({taskId,taskVersion}){
      const version=taskVersion===undefined
        ? db.prepare('SELECT MAX(task_version) AS v FROM task_questions WHERE task_id=?').get(Number(taskId))?.v
        : Number(taskVersion);
      if(version===undefined||version===null)return [];
      return db.prepare('SELECT * FROM task_questions WHERE task_id=? AND task_version=? ORDER BY key')
        .all(Number(taskId),Number(version));
    },
    saveAnswers({taskId,taskVersion,answers,requestId=null,answeredAt=nowIso()}){
      for(const answer of answers||[]){
        db.prepare(`INSERT OR REPLACE INTO task_answers
          (task_id,task_version,key,value,scope,answered_at,request_id)
          VALUES(?,?,?,?,?,?,?)`)
          .run(Number(taskId),Number(taskVersion),String(answer.key),String(answer.value),
            String(answer.scope||'task'),answeredAt,requestId);
      }
      return (answers||[]).length;
    },
    answers({taskId,taskVersion}){
      return db.prepare('SELECT * FROM task_answers WHERE task_id=? AND task_version=? ORDER BY key')
        .all(Number(taskId),Number(taskVersion));
    },
    // 一个任务可能经历多轮问答；准备 worker 需要每个字段最新一次的回答。
    latestAnswers({taskId}){
      const rows=db.prepare('SELECT * FROM task_answers WHERE task_id=? ORDER BY task_version DESC,key')
        .all(Number(taskId));
      const seen=new Set();
      return rows.filter(row=>{
        if(seen.has(row.key))return false;
        seen.add(row.key);
        return true;
      });
    },
    savePlan({taskId,plan,digest,preconditions=null,expiresAt=null,createdAt=nowIso()}){
      db.exec('BEGIN IMMEDIATE');
      try{
        const task=db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(taskId));
        if(!task)throw Error('task_not_found');
        const row=db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM plans WHERE task_id=?').get(Number(taskId));
        const version=Number(row.v)+1;
        db.prepare("UPDATE plans SET status='superseded' WHERE task_id=? AND status='current'").run(Number(taskId));
        const info=db.prepare(`INSERT INTO plans
          (task_id,version,kind,document_ref,digest,plan_json,preconditions_json,status,expires_at,created_at)
          VALUES(?,?,?,?,?,?,?,'current',?,?)`)
          .run(Number(taskId),version,String(task.kind),String(task.target_ref),String(digest),
            JSON.stringify(plan),jsonText(preconditions),expiresAt,createdAt);
        const planId=Number(info.lastInsertRowid);
        db.prepare('UPDATE tasks SET current_plan_id=?,updated_at=? WHERE id=?')
          .run(planId,createdAt,Number(taskId));
        db.exec('COMMIT');
        return db.prepare('SELECT * FROM plans WHERE id=?').get(planId);
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
    },
    currentPlan({taskId,accountRef}){
      return db.prepare(`SELECT p.* FROM plans p JOIN tasks t ON t.id=p.task_id
        WHERE p.task_id=? AND t.account_ref=? AND p.id=t.current_plan_id`)
        .get(Number(taskId),String(accountRef))||null;
    },
    getPlan({id,accountRef}){
      return db.prepare(`SELECT p.* FROM plans p JOIN tasks t ON t.id=p.task_id
        WHERE p.id=? AND t.account_ref=?`).get(Number(id),String(accountRef))||null;
    },
    createApproval({taskId,planId,planVersion,planDigest,decision='approved',clientRequestId,actorDeviceId=null,createdAt=nowIso()}){
      db.exec('BEGIN IMMEDIATE');
      try{
        const key=String(taskId)+':'+String(planId)+':fill';
        const existingOperation=db.prepare('SELECT * FROM operations WHERE idempotency_key=?').get(key);
        if(existingOperation){
          const existingApproval=db.prepare('SELECT * FROM approvals WHERE task_id=? AND plan_id=? ORDER BY id DESC LIMIT 1')
            .get(Number(taskId),Number(planId));
          db.exec('COMMIT');
          return {approval:existingApproval,operation:existingOperation};
        }
        const plan=db.prepare('SELECT * FROM plans WHERE id=? AND task_id=?').get(Number(planId),Number(taskId));
        if(!plan||plan.status!=='current'||String(plan.digest)!==String(planDigest)||Number(plan.version)!==Number(planVersion)){
          throw Error('plan_not_current');
        }
        const approvalInfo=db.prepare(`INSERT INTO approvals
          (task_id,plan_id,plan_version,plan_digest,decision,actor_device_id,client_request_id,created_at)
          VALUES(?,?,?,?,?,?,?,?)`)
          .run(Number(taskId),Number(planId),Number(planVersion),String(planDigest),String(decision),
            actorDeviceId,String(clientRequestId),createdAt);
        const operationInfo=db.prepare(`INSERT INTO operations
          (task_id,plan_id,kind,state,attempt,idempotency_key)
          VALUES(?,?,'fill','queued',0,?)`)
          .run(Number(taskId),Number(planId),key);
        const approval=db.prepare('SELECT * FROM approvals WHERE id=?').get(Number(approvalInfo.lastInsertRowid));
        const operation=db.prepare('SELECT * FROM operations WHERE id=?').get(Number(operationInfo.lastInsertRowid));
        db.exec('COMMIT');
        return {approval,operation};
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
    },
    getOperation({id,taskId}){
      return db.prepare('SELECT * FROM operations WHERE id=? AND task_id=?')
        .get(Number(id),Number(taskId))||null;
    },
    // 任务最近一次操作；必须带 accountRef，避免 API 或 worker 跨账号读取。
    latestOperation({taskId,accountRef}){
      return db.prepare(`SELECT o.* FROM operations o JOIN tasks t ON t.id=o.task_id
        WHERE o.task_id=? AND t.account_ref=? ORDER BY o.id DESC LIMIT 1`)
        .get(Number(taskId),String(accountRef))||null;
    },
    beginOperation({operationId,now=nowIso()}){
      const operation=db.prepare('SELECT * FROM operations WHERE id=?').get(Number(operationId));
      if(!operation)throw Error('operation_not_found');
      if(operation.state==='completed'||operation.state==='unknown')return operation;
      db.prepare(`UPDATE operations SET state='running',attempt=attempt+1,
        started_at=COALESCE(started_at,?),error_class=NULL WHERE id=?`)
        .run(now,Number(operationId));
      return db.prepare('SELECT * FROM operations WHERE id=?').get(Number(operationId));
    },
    // expectedState 用于核对等并发场景：只有 operation 仍处于预期状态时才允许更新。
    // 完成时清空 error_class，避免上一次核对/登录失败的错误类别残留到 completed。
    completeOperation({operationId,evidence=null,now=nowIso(),expectedState=null}){
      const sql=expectedState
        ? `UPDATE operations SET state='completed',evidence_json=?,error_class=NULL,finished_at=?
           WHERE id=? AND state=?`
        : `UPDATE operations SET state='completed',evidence_json=?,error_class=NULL,finished_at=?
           WHERE id=?`;
      const params=[evidence===null?null:JSON.stringify(evidence),now,Number(operationId)];
      if(expectedState)params.push(String(expectedState));
      const changed=db.prepare(sql).run(...params).changes;
      if(changed!==1)return null;
      return db.prepare('SELECT * FROM operations WHERE id=?').get(Number(operationId));
    },
    failOperation({operationId,state='failed_retryable',errorClass=null,evidence=null,now=nowIso(),expectedState=null}){
      if(!['failed_retryable','unknown','failed_terminal'].includes(state))throw Error('invalid_operation_state');
      const sql=expectedState
        ? `UPDATE operations SET state=?,error_class=?,evidence_json=?,finished_at=?
           WHERE id=? AND state=?`
        : `UPDATE operations SET state=?,error_class=?,evidence_json=?,finished_at=? WHERE id=?`;
      const params=[state,errorClass,evidence===null?null:JSON.stringify(evidence),now,Number(operationId)];
      if(expectedState)params.push(String(expectedState));
      const changed=db.prepare(sql).run(...params).changes;
      if(changed!==1)return null;
      return db.prepare('SELECT * FROM operations WHERE id=?').get(Number(operationId));
    },
    // 审批、操作入队和任务状态在同一个事务中完成；重复请求返回同一个操作。
    approve({taskId,accountRef,planId,planVersion,planDigest,clientRequestId,actorDeviceId=null,createdAt=nowIso()}){
      db.exec('BEGIN IMMEDIATE');
      try{
        const task=getTask({id:taskId,accountRef});
        if(!task)throw Error('task_not_found');
        if(!clientRequestId)throw Error('client_request_id_required');
        const key=String(task.id)+':'+String(planId)+':fill';
        const existingOperation=db.prepare('SELECT * FROM operations WHERE idempotency_key=?').get(key);
        if(existingOperation){
          const existingApproval=db.prepare('SELECT * FROM approvals WHERE task_id=? AND plan_id=? ORDER BY id DESC LIMIT 1')
            .get(Number(task.id),Number(planId));
          const current=getTask({id:task.id,accountRef});
          db.exec('COMMIT');
          return {created:false,task:current,approval:existingApproval,operation:existingOperation};
        }
        if(task.state!=='awaiting_approval')throw Error('invalid_transition_'+task.state+'_approve');
        const plan=db.prepare('SELECT * FROM plans WHERE id=? AND task_id=?').get(Number(planId),Number(task.id));
        if(!plan||plan.status!=='current'||String(plan.digest)!==String(planDigest)||Number(plan.version)!==Number(planVersion)){
          throw Error('plan_not_current');
        }
        const approvalInfo=db.prepare(`INSERT INTO approvals
          (task_id,plan_id,plan_version,plan_digest,decision,actor_device_id,client_request_id,created_at)
          VALUES(?,?,?,?, 'approved',?,?,?)`)
          .run(Number(task.id),Number(plan.id),Number(plan.version),String(plan.digest),
            actorDeviceId,String(clientRequestId),createdAt);
        const operationInfo=db.prepare(`INSERT INTO operations
          (task_id,plan_id,kind,state,attempt,idempotency_key)
          VALUES(?,?,'fill','queued',0,?)`)
          .run(Number(task.id),Number(plan.id),key);
        const next=transition(task.state,'approve');
        const updated=db.prepare(`UPDATE tasks SET state=?,state_version=state_version+1,
          updated_at=?,waiting_reason=NULL WHERE id=? AND state=? AND state_version=?`)
          .run(next,createdAt,Number(task.id),task.state,task.state_version);
        if(updated.changes!==1)throw Error('task_state_conflict');
        const approval=db.prepare('SELECT * FROM approvals WHERE id=?').get(Number(approvalInfo.lastInsertRowid));
        const operation=db.prepare('SELECT * FROM operations WHERE id=?').get(Number(operationInfo.lastInsertRowid));
        const current=getTask({id:task.id,accountRef});
        db.exec('COMMIT');
        return {created:true,task:current,approval,operation};
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
    },
    acquireLock({lockKey,ownerId,taskId=null,operationId=null,ttlSeconds=60,now=nowIso()}){
      db.exec('BEGIN IMMEDIATE');
      try{
        const existing=db.prepare('SELECT * FROM document_locks WHERE lock_key=?').get(String(lockKey));
        if(existing&&existing.owner_id!==String(ownerId)&&existing.expires_at>now){
          db.exec('COMMIT');
          return false;
        }
        const expiresAt=new Date(new Date(now).getTime()+Number(ttlSeconds)*1000).toISOString();
        db.prepare(`INSERT OR REPLACE INTO document_locks
          (lock_key,owner_id,task_id,operation_id,acquired_at,expires_at)
          VALUES(?,?,?,?,?,?)`)
          .run(String(lockKey),String(ownerId),taskId===null?null:Number(taskId),
            operationId===null?null:Number(operationId),now,expiresAt);
        db.exec('COMMIT');
        return true;
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
    },
    releaseLock({lockKey,ownerId}){
      return db.prepare('DELETE FROM document_locks WHERE lock_key=? AND owner_id=?')
        .run(String(lockKey),String(ownerId)).changes===1;
    }
  };
}

module.exports={createTaskRepository};
