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
function mapMessage(row){
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
    read:!!row.read_at
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
const knownErrors=new Set(['invalid_cursor','message_not_found','suggestion_not_found','suggestion_already_decided','invalid_body','body_too_large','invalid_json']);

function createV2Handler({messages,suggestions,config}){
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
        send(res,200,{items:result.items.map(mapMessage),next_cursor:result.nextCursor,has_more:result.hasMore});
        return true;
      }
      const messageMatch=pathname.match(/^\/v1\/messages\/(\d+)$/);
      if(messageMatch){
        const id=Number(messageMatch[1]);
        if(req.method==='GET'){
          const row=messages.get({id,accountRef});
          if(!row){send(res,404,{error:'message_not_found'});return true;}
          const related=suggestions.listForMessage({messageId:id,accountRef});
          send(res,200,{...mapMessage(row),suggestions:related.map(mapSuggestion)});
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
      return false;
    }catch(error){
      const message=String(error.message||error).split('\n')[0];
      if(message==='suggestion_not_found'||message==='message_not_found'){
        send(res,404,{error:message});
      }else if(message==='suggestion_already_decided'){
        send(res,409,{error:message});
      }else if(knownErrors.has(message)){
        send(res,400,{error:message});
      }else{
        send(res,500,{error:'internal_error'});
      }
      return true;
    }
  };
}

module.exports={createV2Handler,mapMessage,mapSuggestion};
