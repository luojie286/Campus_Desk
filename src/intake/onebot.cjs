// OneBot 事件归一化：只负责把消息变成可持久化的记录并排队分类。
// 这一层不打开浏览器、不调用文档执行器；是否生成候选由后续 worker 决定。
const {sourceMatches,extractLinks,eventKey}=require('../core.cjs');

function filePartsOf(rawMessage){
  if(!Array.isArray(rawMessage))return [];
  return rawMessage.filter(part=>part&&(part.type==='file'||part.type==='image')).map((part,index)=>{
    const data=part.data||{};
    const isImage=part.type==='image';
    return {
      kind:isImage?'image':'file',
      platformFileId:String(data.file_id||data.fileId||data.id||data.file||('file-'+index)),
      fileName:data.file_name||data.name||data.file||(isImage?'image-'+index+'.jpg':null),
      mimeType:data.mime_type||data.mimeType||(isImage?'image/*':null),
      sizeBytes:Number.isFinite(Number(data.file_size||data.size))?Number(data.file_size||data.size):null
    };
  });
}
function normalizeOneBotEvent(event,config,source=null){
  const activeSource=source||config.source;
  if(!sourceMatches(event,activeSource))return null;
  let eventId;
  try{eventId=eventKey(event);}
  catch{return {error:'missing_stable_id'};}
  const rawMessage=event.message??event.raw_message??'';
  const text=Array.isArray(rawMessage)
    ? rawMessage.filter(part=>part&&part.type==='text').map(part=>part.data?.text||'').join('')
    : String(rawMessage);
  const links=extractLinks(event);
  const files=filePartsOf(rawMessage);
  const accountRef=config.account_id?String(config.account_id):String(event.self_id);
  return {
    eventId,
    links,
    files,
    message:{
      platform:'qq',
      adapterInstance:config.adapter_instance||'onebot-main',
      accountRef,
      conversationType:event.message_type,
      conversationId:String(event.group_id??event.user_id),
      conversationName:activeSource.display_name||null,
      senderId:String(event.user_id),
      senderName:event.sender?.card||event.sender?.nickname||null,
      sourceMessageId:String(event.message_id),
      sourceTime:event.time?new Date(Number(event.time)*1000).toISOString():null,
      receivedAt:new Date().toISOString(),
      kind:files.some(item=>item.kind==='image')?'image':(files.length?'file':'text'),
      contentText:text,
      contentJson:JSON.stringify(rawMessage),
      linkJson:JSON.stringify(links),
      completeness:'full',
      identityQuality:'stable_id',
      rawJson:JSON.stringify(event)
    }
  };
}

function ingestEvent({event,config,messages,jobs,files,source=null,now=new Date().toISOString()}){
  const normalized=normalizeOneBotEvent(event,config,source);
  if(!normalized)return {stored:false,reason:'source_filtered'};
  if(normalized.error)return {stored:false,reason:normalized.error};
  if(normalized.files.length&&!files)throw Error('file_repository_required');
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
    for(const item of normalized.files){
      const row=files.insert({
        messageId:result.id,
        accountRef:normalized.message.accountRef,
        platformFileId:item.platformFileId,
        fileName:item.fileName,
        mimeType:item.mimeType,
        sizeBytes:item.sizeBytes,
        createdAt:now
      });
      jobs.enqueue({
        type:'process_file',
        payload:{fileId:row.id,messageId:result.id,accountRef:normalized.message.accountRef},
        runAt:now
      });
    }
  }
  return {
    stored:true,
    duplicate:false,
    messageId:result.id,
    inserted:result.inserted,
    links:normalized.links,
    fileIds:result.inserted&&files
      ? files.listForMessage({messageId:result.id,accountRef:normalized.message.accountRef}).map(row=>row.id)
      : []
  };
}

module.exports={normalizeOneBotEvent,ingestEvent};
