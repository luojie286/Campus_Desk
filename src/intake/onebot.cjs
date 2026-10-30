// OneBot 事件归一化：只负责把消息变成可持久化的记录并排队分类。
// 这一层不打开浏览器、不调用文档执行器；是否生成候选由后续 worker 决定。
const {sourceMatches,extractLinks,eventKey}=require('../core.cjs');

function normalizeOneBotEvent(event,config){
  if(!sourceMatches(event,config.source))return null;
  let eventId;
  try{eventId=eventKey(event);}
  catch{return {error:'missing_stable_id'};}
  const rawMessage=event.message??event.raw_message??'';
  const text=Array.isArray(rawMessage)
    ? rawMessage.filter(part=>part&&part.type==='text').map(part=>part.data?.text||'').join('')
    : String(rawMessage);
  const links=extractLinks(event);
  const accountRef=config.account_id?String(config.account_id):String(event.self_id);
  return {
    eventId,
    links,
    message:{
      platform:'qq',
      adapterInstance:config.adapter_instance||'onebot-main',
      accountRef,
      conversationType:event.message_type,
      conversationId:String(event.group_id??event.user_id),
      senderId:String(event.user_id),
      sourceMessageId:String(event.message_id),
      sourceTime:event.time?new Date(Number(event.time)*1000).toISOString():null,
      receivedAt:new Date().toISOString(),
      kind:'text',
      contentText:text,
      contentJson:JSON.stringify(rawMessage),
      linkJson:JSON.stringify(links),
      completeness:'full',
      identityQuality:'stable_id',
      rawJson:JSON.stringify(event)
    }
  };
}

function ingestEvent({event,config,messages,jobs,now=new Date().toISOString()}){
  const normalized=normalizeOneBotEvent(event,config);
  if(!normalized)return {stored:false,reason:'source_filtered'};
  if(normalized.error)return {stored:false,reason:normalized.error};
  const isNew=messages.insertInbound({
    adapterInstance:normalized.message.adapterInstance,
    eventId:normalized.eventId,
    eventType:'message',
    receivedAt:now,
    rawSha256:null
  });
  if(!isNew)return {stored:false,duplicate:true};
  const result=messages.insert(normalized.message);
  if(result.inserted){
    jobs.enqueue({
      type:'classify_message',
      payload:{messageId:result.id,accountRef:normalized.message.accountRef},
      runAt:now
    });
  }
  return {
    stored:true,
    duplicate:false,
    messageId:result.id,
    inserted:result.inserted,
    links:normalized.links
  };
}

module.exports={normalizeOneBotEvent,ingestEvent};
