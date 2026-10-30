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
    conversation:{type:row.conversation_type,id:row.conversation_id},
    sender:{id:row.sender_id},
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
    last_sender_id:row.last_sender_id,
    last_text:row.last_text
  };
}
function mapSuggestion(row){
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
    received_at:row.received_at
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
const knownErrors=new Set(['invalid_cursor','message_not_found','suggestion_not_found','suggestion_already_decided','invalid_body','body_too_large','invalid_json']);

function createV2Handler({messages,suggestions,tasks,jobs,files,config}){
  return async function handle(req,res,pathname,searchParams){
    if(!authorized(req,config.token)){send(res,401,{error:'unauthorized'});return true;}
    const accountRef=config.account_id?String(config.account_id):'';
    if(!accountRef){send(res,500,{error:'account_not_configured'});return true;}
    try{
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
      const messageMatch=pathname.match(/^\/v1\/messages\/(\d+)$/);
      if(messageMatch){
        const id=Number(messageMatch[1]);
        if(req.method==='GET'){
          const row=messages.get({id,accountRef});
          if(!row){send(res,404,{error:'message_not_found'});return true;}
          const related=suggestions.listForMessage({messageId:id,accountRef});
          const fileRows=files?files.listForMessage({messageId:id,accountRef}):[];
          send(res,200,{...mapMessage(row,fileRows),suggestions:related.map(mapSuggestion)});
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
        send(res,200,{items:items.map(mapSuggestion)});
        return true;
      }
      const suggestionMatch=pathname.match(/^\/v1\/suggestions\/(\d+)\/(accept|dismiss)$/);
      if(suggestionMatch&&req.method==='POST'){
        const id=Number(suggestionMatch[1]);
        const body=await readJson(req);
        const deviceId=body.device_id?String(body.device_id):null;
        if(suggestionMatch[2]==='accept'){
          const result=suggestions.accept({id,accountRef,deviceId});
          send(res,200,{suggestion:mapSuggestion(result.suggestion),todo:result.todo,tasks:result.tasks||[]});
          return true;
        }
        const dismissed=suggestions.dismiss({id,accountRef,deviceId});
        send(res,200,{suggestion:mapSuggestion(dismissed)});
        return true;
      }
      if(req.method==='GET'&&pathname==='/v1/todos'){
        const items=suggestions.listTodos({accountRef,status:searchParams.get('status')||null});
        send(res,200,{items});
        return true;
      }
      if(pathname==='/v1/tasks'||pathname.startsWith('/v1/tasks/')){
        if(!tasks)throw Error('task_repository_unavailable');
        if(req.method==='GET'&&pathname==='/v1/tasks'){
          const items=tasks.list({accountRef,state:searchParams.get('state')||null,limit:searchParams.get('limit')||100});
          send(res,200,{items:items.map(mapTask)});
          return true;
        }
        const taskMatch=pathname.match(/^\/v1\/tasks\/(\d+)(?:\/(plan|answers|approvals|cancel|operations\/(\d+)))?$/);
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
            answers:tasks.latestAnswers({taskId})
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
      if(message==='suggestion_not_found'||message==='message_not_found'||message==='task_not_found'||message==='plan_not_found'||message==='operation_not_found'){
        send(res,404,{error:message});
      }else if(message==='task_account_mismatch'){
        send(res,403,{error:message});
      }else if(message==='suggestion_already_decided'||message.startsWith('invalid_transition_')||message==='plan_not_current'||message==='task_state_conflict'||message==='execute_disabled'){
        send(res,409,{error:message});
      }else if(message==='task_repository_unavailable'||message==='job_repository_unavailable'){
        send(res,503,{error:message});
      }else if(knownErrors.has(message)||message==='answers_required'||message==='invalid_answer'||message==='client_request_id_required'){
        send(res,400,{error:message});
      }else{
        send(res,500,{error:'internal_error'});
      }
      return true;
    }
  };
}

module.exports={createV2Handler,mapMessage,mapSuggestion};
