// 消息中心/待办候选 API：所有查询都按当前账号隔离，不返回 raw_json。
// 这一层只做读取、候选接受/忽略和待办创建；不会触发文档读写。
function send(res,status,data){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(data));
}
function authorized(req,token){
  return !!token&&req.headers.authorization==='Bearer '+token;
}
async function readJson(req,max=65536){
  let chunks=[],length=0;
  for await(const chunk of req){
    length+=chunk.length;
    if(length>max)throw Error('body_too_large');
    chunks.push(chunk);
  }
  if(!length)return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function linksOf(row){
  try{return JSON.parse(row.link_json||'[]');}catch{return [];}
}
function mapFile(row){
  return {
    id:row.id,
    file_name:row.file_name,
    mime_type:row.mime_type,
    size_bytes:row.size_bytes,
    download_state:row.download_state,
    text_state:row.text_state
  };
}
function mapMessage(row,fileRows=[]){
  return {
    id:row.id,
    platform:row.platform,
    conversation:{type:row.conversation_type,id:row.conversation_id,name:row.conversation_name||null},
    sender:{id:row.sender_id,name:row.sender_name||null},
    source_time:row.source_time,
    received_at:row.received_at,
    kind:row.kind,
    text:row.content_text,
    links:linksOf(row),
    files:Array.isArray(fileRows)?fileRows.map(mapFile):[],
    read:!!row.read_at
  };
}
function mapSource(row){
  return {
    conversation_type:row.conversation_type,
    conversation_id:row.conversation_id,
    total:row.total,
    unread:row.unread,
    last_at:row.last_at,
    conversation_name:row.conversation_name||null,
    last_sender_id:row.last_sender_id,
    last_sender_name:row.last_sender_name||null,
    last_text:row.last_text
  };
}
function mapNotification(row){
  return {
    id:row.id,
    kind:row.kind,
    title:row.title,
    body:row.body,
    read:!!row.read_at,
    created_at:row.created_at
  };
}
function mapListenSource(row){
  return {
    id:row.id,
    platform:row.platform,
    account_ref:row.account_ref,
    conversation_type:row.conversation_type,
    conversation_id:row.conversation_id,
    sender_id:row.sender_id||'',
    display_name:row.display_name||null,
    enabled:!!row.enabled
  };
}
function mapSuggestion(row,sourceRows=[]){
  return {
    id:row.id,
    message_id:row.message_id,
    kind:row.kind,
    title:row.title,
    summary:row.summary,
    category:row.category,
    confidence:row.confidence,
    status:row.status,
    rationale:row.rationale,
    created_at:row.created_at,
    decided_at:row.decided_at,
    links:linksOf(row),
    message_text:row.content_text,
    sender_id:row.sender_id,
    conversation_id:row.conversation_id,
    received_at:row.received_at,
    thread_key:row.thread_key||null,
    source_count:row.source_count??Math.max(1,sourceRows.length),
    sources:sourceRows.map(source=>({
      id:source.id,
      sender_id:source.sender_id,
      received_at:source.received_at,
      text:source.content_text
    }))
  };
}
function parseJson(value,fallback=null){
  if(value===null||value===undefined||value==='')return fallback;
  try{return JSON.parse(value);}catch{return fallback;}
}
function mapTask(row){
  return {
    id:row.id,
    todo_id:row.todo_id,
    kind:row.kind,
    executor_type:row.executor_type,
    account_ref:row.account_ref,
    target_ref:row.target_ref,
    state:row.state,
    state_version:row.state_version,
    waiting_reason:row.waiting_reason,
    current_plan_id:row.current_plan_id,
    created_at:row.created_at,
    updated_at:row.updated_at,
    completed_at:row.completed_at,
    metadata:parseJson(row.metadata_json,{})
  };
}
function mapPlan(row){
  if(!row)return null;
  return {
    id:row.id,
    task_id:row.task_id,
    version:row.version,
    kind:row.kind,
    document_ref:row.document_ref,
    digest:row.digest,
    plan:parseJson(row.plan_json,{}),
    preconditions:parseJson(row.preconditions_json,null),
    status:row.status,
    created_at:row.created_at
  };
}
// 只返回桌面需要的操作字段；不暴露 idempotency_key，证据已解析为对象。
function mapOperation(row){
  if(!row)return null;
  return {
    id:row.id,
    task_id:row.task_id,
    plan_id:row.plan_id,
    kind:row.kind,
    state:row.state,
    attempt:row.attempt,
    error_class:row.error_class,
    evidence:parseJson(row.evidence_json,null),
    started_at:row.started_at,
    finished_at:row.finished_at
  };
}
const knownErrors=new Set(['invalid_cursor','message_not_found','suggestion_not_found','suggestion_already_decided','invalid_body','body_too_large','invalid_json']);

function createV2Handler({messages,suggestions,tasks,jobs,files,sources,notifications,contacts,briefings,config}){
  return async function handle(req,res,pathname,searchParams){
    if(!authorized(req,config.token)){send(res,401,{error:'unauthorized'});return true;}
    const accountRef=config.account_id?String(config.account_id):'';
    if(!accountRef){send(res,500,{error:'account_not_configured'});return true;}
    // 手机网关带上它认证的账号；后台仍在运行旧配置时拒绝跨账号转发。
    if(req.headers['x-campus-account']&&req.headers['x-campus-account']!==accountRef){
      send(res,409,{error:'gateway_account_mismatch'});return true;
    }
    try{
      if(pathname==='/v1/briefing-settings'||pathname.startsWith('/v1/briefings')){
        if(!briefings){send(res,503,{error:'briefing_unavailable'});return true;}
        if(pathname==='/v1/briefing-settings'&&req.method==='GET'){
          send(res,200,briefings.settings(accountRef));return true;
        }
        if(pathname==='/v1/briefing-settings'&&req.method==='PUT'){
          let result;try{result=briefings.saveSettings(accountRef,await readJson(req));}
          catch{send(res,400,{error:'invalid_briefing_settings'});return true;}
          send(res,200,result);return true;
        }
        if(pathname==='/v1/briefings'&&req.method==='GET'){
          send(res,200,{items:briefings.list(accountRef)});return true;
        }
        if(pathname==='/v1/briefings/today'&&req.method==='POST'){
          const row=briefings.ensure(accountRef,new Date().toISOString(),true);
          send(res,row.state==='ready'?200:202,briefings.get(accountRef,row.id));return true;
        }
        const match=pathname.match(/^\/v1\/briefings\/(\d+)$/);
        if(match&&req.method==='GET'){
          const item=briefings.get(accountRef,match[1]);send(res,item?200:404,item||{error:'briefing_not_found'});return true;
        }
        return false;
      }
      if(req.method==='GET'&&pathname==='/v1/messages'){
        const result=messages.list({
          accountRef,
          cursor:searchParams.get('cursor')||null,
          limit:searchParams.get('limit')||30,
          senderId:searchParams.get('sender_id')||null,
          conversationId:searchParams.get('conversation_id')||null,
          unreadOnly:searchParams.get('unread')==='1'
        });
        const items=result.items.map(item=>mapMessage(item,files?files.listForMessage({messageId:item.id,accountRef}):[]));
        send(res,200,{items,next_cursor:result.nextCursor,has_more:result.hasMore});
        return true;
      }
      if(req.method==='GET'&&pathname==='/v1/sources'){
        send(res,200,{items:messages.sources({accountRef}).map(mapSource)});
        return true;
      }
      if(pathname==='/v1/notifications'||pathname.startsWith('/v1/notifications/')){
        if(!notifications)throw Error('notification_repository_unavailable');
        if(req.method==='GET'&&pathname==='/v1/notifications'){
          const items=notifications.list({
            accountRef,
            unreadOnly:searchParams.get('unread')==='1',
            limit:searchParams.get('limit')||50
          });
          send(res,200,{items:items.map(mapNotification),unread:notifications.unreadCount({accountRef})});
          return true;
        }
        const notificationMatch=pathname.match(/^\/v1\/notifications\/(\d+)\/read$/);
        if(req.method==='POST'&&notificationMatch){
          if(!notifications.markRead({id:Number(notificationMatch[1]),accountRef}))throw Error('notification_not_found');
          send(res,200,{ok:true});
          return true;
        }
        return false;
      }
      if(pathname==='/v1/listen-sources'||pathname.startsWith('/v1/listen-sources/')){
        if(!sources)throw Error('source_repository_unavailable');
        if(req.method==='GET'&&pathname==='/v1/listen-sources'){
          send(res,200,{items:sources.list({accountRef}).map(mapListenSource)});
          return true;
        }
        if(req.method==='POST'&&pathname==='/v1/listen-sources'){
          const body=await readJson(req);
          if(!['group','private'].includes(body.conversation_type))throw Error('source_type_invalid');
          const added=sources.add({
            accountRef,
            conversationType:body.conversation_type,
            conversationId:String(body.conversation_id||''),
            senderId:body.sender_id?String(body.sender_id):'',
            displayName:body.display_name||null
          });
          messages.backfillNames({accountRef});
          send(res,200,{source:mapListenSource(added)});
          return true;
        }
        const listenMatch=pathname.match(/^\/v1\/listen-sources\/(\d+)$/);
        if(listenMatch){
          const id=Number(listenMatch[1]);
          if(req.method==='DELETE'){
            if(!sources.remove({id,accountRef}))throw Error('source_not_found');
            send(res,200,{ok:true});
            return true;
          }
          if(req.method==='PATCH'){
            const body=await readJson(req);
            if(typeof body.enabled!=='boolean')throw Error('invalid_body');
            if(!sources.setEnabled({id,accountRef,enabled:body.enabled}))throw Error('source_not_found');
            send(res,200,{ok:true});
            return true;
          }
        }
        return false;
      }
      if(pathname.startsWith('/v1/contacts/')){
        if(!contacts)throw Error('contact_service_unavailable');
        if(req.method==='POST'&&pathname==='/v1/contacts/refresh'){
          if(!sources)throw Error('source_repository_unavailable');
          const [groups,friends]=await Promise.all([
            contacts.getGroups({config}),
            contacts.getFriends({config})
          ]);
          const groupNames=new Map(groups.map(item=>[String(item.id),item.name]));
          const friendNames=new Map(friends.map(item=>[String(item.id),item.name]));
          let updated=0;
          for(const row of sources.list({accountRef})){
            const name=row.conversation_type==='group'
              ? groupNames.get(String(row.conversation_id))
              : friendNames.get(String(row.conversation_id));
            if(name&&name!==row.display_name){
              if(sources.updateDisplayName({id:row.id,accountRef,displayName:name}))updated++;
            }
          }
          messages.backfillNames({accountRef});
          send(res,200,{updated});
          return true;
        }
        if(req.method==='GET'&&pathname==='/v1/contacts/groups'){
          send(res,200,{items:await contacts.getGroups({config})});
          return true;
        }
        const memberMatch=pathname.match(/^\/v1\/contacts\/groups\/(\d+)\/members$/);
        if(req.method==='GET'&&memberMatch){
          send(res,200,{items:await contacts.getGroupMembers(memberMatch[1],{config})});
          return true;
        }
        if(req.method==='GET'&&pathname==='/v1/contacts/friends'){
          send(res,200,{items:await contacts.getFriends({config})});
          return true;
        }
        return false;
      }
      const messageMatch=pathname.match(/^\/v1\/messages\/(\d+)$/);
      if(messageMatch){
        const id=Number(messageMatch[1]);
        if(req.method==='GET'){
          const row=messages.get({id,accountRef});
          if(!row){send(res,404,{error:'message_not_found'});return true;}
          const related=suggestions.listForMessage({messageId:id,accountRef});
          const fileRows=files?files.listForMessage({messageId:id,accountRef}):[];
          send(res,200,{...mapMessage(row,fileRows),suggestions:related.map(item=>mapSuggestion(item,suggestions.sources({suggestionId:item.id,accountRef})))});
          return true;
        }
        if(req.method==='PATCH'){
          const body=await readJson(req);
          if(body.read!==true){send(res,400,{error:'invalid_body'});return true;}
          const ok=messages.markRead({id,accountRef});
          if(!ok){send(res,404,{error:'message_not_found'});return true;}
          send(res,200,{ok:true});
          return true;
        }
      }
      if(req.method==='GET'&&pathname==='/v1/suggestions'){
        const status=searchParams.get('status')||'pending';
        const items=suggestions.list({accountRef,status,limit:searchParams.get('limit')||50});
        send(res,200,{items:items.map(item=>mapSuggestion(item,suggestions.sources({suggestionId:item.id,accountRef})))});
        return true;
      }
      const suggestionMatch=pathname.match(/^\/v1\/suggestions\/(\d+)\/(accept|dismiss)$/);
      if(suggestionMatch&&req.method==='POST'){
        const id=Number(suggestionMatch[1]);
        const body=await readJson(req);
        const deviceId=body.device_id?String(body.device_id):null;
        if(suggestionMatch[2]==='accept'){
          const result=suggestions.accept({id,accountRef,deviceId});
          send(res,200,{suggestion:mapSuggestion(result.suggestion,suggestions.sources({suggestionId:result.suggestion.id,accountRef})),todo:result.todo,tasks:result.tasks||[]});
          return true;
        }
        const dismissed=suggestions.dismiss({id,accountRef,deviceId});
        send(res,200,{suggestion:mapSuggestion(dismissed,suggestions.sources({suggestionId:dismissed.id,accountRef}))});
        return true;
      }
      if(req.method==='GET'&&pathname==='/v1/todos'){
        const items=suggestions.listTodos({accountRef,status:searchParams.get('status')||null});
        send(res,200,{items});
        return true;
      }
      const todoMatch=pathname.match(/^\/v1\/todos\/([1-9]\d*)\/(complete|reopen|delete)$/);
      if(req.method==='POST'&&todoMatch){
        await readJson(req);
        const todo=suggestions.updateTodo({id:Number(todoMatch[1]),accountRef,action:todoMatch[2]});
        send(res,200,{todo});return true;
      }
      if(pathname==='/v1/tasks'||pathname.startsWith('/v1/tasks/')){
        if(!tasks)throw Error('task_repository_unavailable');
        if(req.method==='GET'&&pathname==='/v1/tasks'){
          const items=tasks.list({accountRef,state:searchParams.get('state')||null,limit:searchParams.get('limit')||100});
          send(res,200,{items:items.map(mapTask)});
          return true;
        }
        const taskMatch=pathname.match(/^\/v1\/tasks\/(\d+)(?:\/(plan|answers|approvals|cancel|reconcile|resume|operations\/(\d+)))?$/);
        if(!taskMatch)return false;
        const taskId=Number(taskMatch[1]);
        let task=tasks.get({id:taskId,accountRef});
        if(!task){
          // 任务存在但属于另一个账号时明确拒绝，而不是伪装成不存在。
          if(tasks.getAny({id:taskId}))throw Error('task_account_mismatch');
          throw Error('task_not_found');
        }
        const action=taskMatch[2]||'detail';
        if(action==='detail'&&req.method==='GET'){
          const plan=tasks.currentPlan({taskId,accountRef});
          send(res,200,{
            ...mapTask(task),
            plan:mapPlan(plan),
            questions:tasks.questions({taskId,taskVersion:task.state_version}),
            answers:tasks.latestAnswers({taskId}),
            // 核对是异步的：桌面需要从详情读取最后一次操作的结果和错误类别。
            latest_operation:mapOperation(tasks.latestOperation({taskId,accountRef}))
          });
          return true;
        }
        if(action==='plan'&&req.method==='GET'){
          const plan=tasks.currentPlan({taskId,accountRef});
          if(!plan)throw Error('plan_not_found');
          send(res,200,mapPlan(plan));
          return true;
        }
        if(action==='answers'&&req.method==='POST'){
          if(task.state!=='awaiting_input')throw Error('invalid_transition_'+task.state+'_answer');
          const body=await readJson(req);
          if(!Array.isArray(body.answers)||!body.answers.length)throw Error('answers_required');
          const questions=tasks.questions({taskId,taskVersion:task.state_version});
          const allowed=new Set(questions.map(question=>question.key));
          const seen=new Set(),answers=[];
          for(const item of body.answers){
            const key=String(item?.key||'');
            const value=String(item?.value??'');
            if(!key||!allowed.has(key)||seen.has(key)||!value||value.length>500)throw Error('invalid_answer');
            seen.add(key);
            answers.push({key,value,scope:'task'});
          }
          tasks.saveAnswers({taskId,taskVersion:task.state_version,answers,requestId:body.client_request_id||null});
          const next=tasks.transition({id:taskId,accountRef,event:'answer'});
          jobs.enqueue({type:'prepare_task',payload:{taskId,accountRef},runAt:new Date().toISOString()});
          send(res,200,{ok:true,state:next.state,task_version:next.state_version});
          return true;
        }
        if(action==='approvals'&&req.method==='POST'){
          if(config.execute!==true)throw Error('execute_disabled');
          const body=await readJson(req);
          if(!body.plan_id||!body.plan_version||!body.plan_digest||!body.client_request_id)throw Error('invalid_body');
          const result=tasks.approve({
            taskId,
            accountRef,
            planId:body.plan_id,
            planVersion:body.plan_version,
            planDigest:body.plan_digest,
            clientRequestId:body.client_request_id,
            actorDeviceId:body.device_id||null
          });
          // 只有第一次审批才入队；重复请求返回同一个操作，不会重复执行。
          if(result.created)jobs.enqueue({
            type:'execute_operation',
            payload:{taskId,accountRef,operationId:result.operation.id},
            runAt:new Date().toISOString()
          });
          send(res,200,{task:mapTask(result.task),approval:result.approval,operation:result.operation});
          return true;
        }
        if(action==='cancel'&&req.method==='POST'){
          const next=tasks.transition({id:taskId,accountRef,event:'cancel'});
          send(res,200,{task:mapTask(next)});
          return true;
        }
        if(action==='reconcile'&&req.method==='POST'){
          // 只核对 outcome_unknown；写入已发生与否由 worker 只读回读判断，API 不做任何写入。
          if(task.state!=='outcome_unknown')throw Error('invalid_transition_'+task.state+'_reconcile');
          const operation=tasks.latestOperation({taskId,accountRef});
          if(!operation||operation.state!=='unknown')throw Error('reconcile_not_available');
          const plan=tasks.getPlan({id:operation.plan_id,accountRef});
          if(!plan||Number(plan.task_id)!==Number(task.id))throw Error('reconcile_not_available');
          const jobId=jobs.enqueueUnique({
            type:'reconcile_task',
            payload:{taskId,accountRef,operationId:operation.id},
            runAt:new Date().toISOString(),
            maxAttempts:3,
            dedupeKey:'reconcile:'+taskId,
            stealExpired:true
          });
          send(res,202,{
            ok:true,
            queued:true,
            state:task.state,
            operation_id:operation.id,
            job_id:jobId,
            task:mapTask(task)
          });
          return true;
        }
        if(action==='resume'&&req.method==='POST'){
          // 登录暂停和写前失败都只需要重新准备；最终写入仍要重新审批。
          const event=task.state==='paused_login_required'?'resume_login'
            :task.state==='failed_retryable'?'retry':null;
          if(!event)throw Error('invalid_transition_'+task.state+'_resume');
          const next=tasks.transition({id:taskId,accountRef,event});
          const jobId=jobs.enqueueUnique({
            type:'prepare_task',
            payload:{taskId,accountRef},
            runAt:new Date().toISOString(),
            dedupeKey:'prepare:'+taskId,
            stealExpired:true
          });
          send(res,200,{
            ok:true,
            state:next.state,
            task_version:next.state_version,
            job_id:jobId,
            task:mapTask(next)
          });
          return true;
        }
        const operationMatch=action.match(/^operations\/(\d+)$/);
        if(operationMatch&&req.method==='GET'){
          const operation=tasks.getOperation({id:Number(operationMatch[1]),taskId});
          if(!operation)throw Error('operation_not_found');
          send(res,200,operation);
          return true;
        }
        return false;
      }
      return false;
    }catch(error){
      const message=String(error.message||error).split('\n')[0];
      if(message==='todo_not_found'||message==='suggestion_not_found'||message==='message_not_found'||message==='task_not_found'||message==='plan_not_found'||message==='operation_not_found'||message==='source_not_found'||message==='notification_not_found'){
        send(res,404,{error:message});
      }else if(message==='task_account_mismatch'){
        send(res,403,{error:message});
      }else if(message==='suggestion_already_decided'||message.startsWith('invalid_transition_')||message==='plan_not_current'||message==='profile_changed'||message==='task_state_conflict'||message==='execute_disabled'||message==='reconcile_not_available'){
        send(res,409,{error:message});
      }else if(message==='task_repository_unavailable'||message==='job_repository_unavailable'||message==='source_repository_unavailable'||message==='contact_service_unavailable'||message==='notification_repository_unavailable'){
        send(res,503,{error:message});
      }else if(message.startsWith('onebot_')){
        send(res,502,{error:message});
      }else if(knownErrors.has(message)||message==='answers_required'||message==='invalid_answer'||message==='client_request_id_required'||message==='source_type_invalid'||message==='source_id_invalid'||message==='source_sender_invalid'){
        send(res,400,{error:message});
      }else{
        send(res,500,{error:'internal_error'});
      }
      return true;
    }
  };
}

module.exports={createV2Handler,mapMessage,mapSuggestion};
