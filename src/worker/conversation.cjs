// 会话级候选 worker：规则先丢弃寒暄，再让 LLM 过滤闲聊并把同事务消息合并。
// 不处理文档链接（直接建任务）和文件附件（文件 worker 单独处理）。
const fs=require('node:fs/promises');
const {buildConversationPayload}=require('../suggest/conversation.cjs');

const ACK_PATTERN=/^(收到|好的|好|嗯|哦|谢谢|感谢|OK|ok|👌|👍|哈+|在吗|辛苦了)[\s!！。.~～]*$/;
const EMOJI_ONLY=/^[\p{Extended_Pictographic}\s]+$/u;

function eligible(message){
  if(!message||message.kind!=='text')return false;
  if(!String(message.content_text||'').trim())return false;
  let links=[];
  try{links=JSON.parse(message.link_json||'[]');}catch{links=[];}
  if(Array.isArray(links)&&links.length)return false;
  const text=String(message.content_text||'').trim();
  if(text.length<=2||ACK_PATTERN.test(text)||EMOJI_ONLY.test(text))return false;
  return true;
}

async function candidateFor(message,files){
  if(message.kind==='file'||message.kind==='image'){
    if(!files)return null;
    const rows=files.listForMessage({messageId:message.id,accountRef:message.account_ref});
    const parts=[];
    for(const file of rows){
      if(file.text_state!=='extracted'||!file.text_path)continue;
      try{
        const text=(await fs.readFile(file.text_path,'utf8')).trim();
        if(text)parts.push(`[附件${file.file_name?'：'+file.file_name:''}]\n${text.slice(0,12000)}`);
      }catch{}
    }
    if(!parts.length)return null;
    return {
      ...message,
      content_text:[message.content_text,...parts].filter(Boolean).join('\n\n')
    };
  }
  return eligible(message)?message:null;
}

function dedupeKey({accountRef,conversationType,conversationId}){
  return `suggest:${accountRef}:${conversationType}:${conversationId}`;
}

async function processNextConversationJob({
  messages,
  suggestions,
  jobs,
  files,
  config,
  workerId,
  now=new Date().toISOString(),
  suggest
}){
  const job=jobs.claim({workerId,leaseSeconds:120,now,type:'suggest_conversation'});
  if(!job)return {processed:false};
  try{
    const payload=JSON.parse(job.payload_json||'{}');
    const accountRef=payload.accountRef;
    const conversationType=payload.conversationType;
    const conversationId=payload.conversationId;
    if(!accountRef||!conversationType||!conversationId)throw Error('conversation_reference_invalid');
    const cursor=messages.conversationCursor({accountRef,conversationType,conversationId});
    const afterId=cursor?.last_message_id||0;
    const rows=messages.messagesAfter({accountRef,conversationType,conversationId,afterId,limit:20});
    if(!rows.length){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:'empty'};
    }
    const maxId=rows[rows.length-1].id;
    const candidates=[];
    for(const row of rows){
      const candidate=await candidateFor(row,files);
      if(candidate)candidates.push(candidate);
    }
    if(!candidates.length){
      messages.setConversationCursor({accountRef,conversationType,conversationId,lastMessageId:maxId,now});
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:'filtered_local',scanned:rows.length};
    }
    if(typeof suggest!=='function')throw Error('suggest_function_required');
    const existing=suggestions.pendingForConversation({accountRef,conversationType,conversationId});
    const llmPayload=buildConversationPayload({
      conversation:{type:conversationType,id:conversationId},
      messages:candidates,
      existing
    });
    const decision=await suggest({payload:llmPayload,config});
    let suggestionId=null;
    let state='filtered';
    if(decision&&decision.actionable){
      const ids=decision.message_ids;
      const primary=candidates.find(message=>message.id===ids[0])||candidates[candidates.length-1];
      const matched=existing.find(item=>item.thread_key===decision.thread_key);
      if(matched){
        const updated=suggestions.updateMerged({
          id:matched.id,
          accountRef,
          title:decision.title,
          summary:decision.summary,
          category:decision.category,
          confidence:decision.confidence,
          rationale:decision.rationale,
          messageIds:ids,
          updatedAt:now
        });
        suggestionId=updated.id;
        state='merged';
      }else{
        suggestionId=suggestions.insert({
          messageId:primary.id,
          messageVersion:1,
          kind:'todo',
          title:decision.title,
          summary:decision.summary,
          category:decision.category,
          confidence:decision.confidence,
          actionJson:{links:[]},
          status:'pending',
          rationale:decision.rationale,
          model:config.llm?.model||'deepseek-chat',
          createdAt:now,
          accountRef,
          conversationType,
          conversationId,
          threadKey:decision.thread_key,
          messageIds:ids
        });
        state='suggested';
      }
    }
    messages.setConversationCursor({accountRef,conversationType,conversationId,lastMessageId:maxId,now});
    jobs.complete(job.id,now);
    // 如果处理期间又来了消息，立刻再排一次；否则等下一批消息的防抖任务。
    const more=messages.messagesAfter({accountRef,conversationType,conversationId,afterId:maxId,limit:1});
    if(more.length){
      jobs.enqueueUnique({
        type:'suggest_conversation',
        payload:{accountRef,conversationType,conversationId},
        runAt:now,
        maxAttempts:3,
        dedupeKey:dedupeKey({accountRef,conversationType,conversationId})
      });
    }
    return {processed:true,jobId:job.id,state,suggestionId,scanned:rows.length,scannedMessages:rows.length};
  }catch(error){
    const message=String(error.message||error).split('\n')[0].slice(0,200);
    jobs.fail(job.id,message,{now});
    return {processed:true,jobId:job.id,error:message};
  }
}

module.exports={processNextConversationJob,eligible,candidateFor,dedupeKey};
