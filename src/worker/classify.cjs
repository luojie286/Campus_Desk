// 分类 worker：规则分类 -> 需要时调用候选模型 -> 保存 pending 候选。
// 只读消息和个人资料，不打开文档、不执行写入。
const {classifyMessage,shouldSuggest}=require('../classify/rules.cjs');
const {buildSuggestionPayload}=require('../suggest/llm.cjs');
const {canonicalUrl}=require('../core.cjs');

async function processNextClassifyJob({messages,suggestions,jobs,classifications,tasks,config,workerId,now=new Date().toISOString(),suggest}){
  const job=jobs.claim({workerId,leaseSeconds:60,now,type:'classify_message'});
  if(!job)return {processed:false};
  try{
    const payload=JSON.parse(job.payload_json||'{}');
    const message=messages.get({id:payload.messageId,accountRef:payload.accountRef});
    if(!message)throw Error('message_not_found');
    let links=[];
    try{links=JSON.parse(message.link_json||'[]');}catch{links=[];}
    const classification=classifyMessage({text:message.content_text,links});
    classifications.insert({
      messageId:message.id,
      messageVersion:1,
      category:classification.category,
      confidence:classification.confidence,
      ruleId:null,
      model:'rules',
      rationale:classification.rule,
      status:'auto',
      createdAt:now
    });
    // 文档链接直接派生填写任务和审批请求，不经过 todo/候选。
    const supportedLinks=[];
    for(const link of links){
      try{supportedLinks.push(canonicalUrl(link));}catch{}
    }
    const createdTasks=[];
    let suggestionId=null;
    if(supportedLinks.length){
      if(!tasks)throw Error('task_repository_required');
      for(const target of supportedLinks){
        const task=tasks.create({
          todoId:null,
          requestKey:'message:'+message.id+':'+target,
          kind:'doc_fill',
          executorType:'tencent_sheet',
          accountRef:message.account_ref,
          targetRef:target,
          metadata:{messageId:message.id},
          createdAt:now
        });
        createdTasks.push(task);
        if(task.created)jobs.enqueue({type:'prepare_task',payload:{taskId:task.id,accountRef:task.account_ref},runAt:now});
      }
    }else if(message.kind!=='file'&&shouldSuggest(classification.category)){
      // 聊天/文件总结才进入待办候选，由用户保留或忽略。
      if(typeof suggest!=='function')throw Error('suggest_function_required');
      const llmPayload=buildSuggestionPayload({
        message:{contentText:message.content_text,links},
        classification
      });
      const decision=await suggest({payload:llmPayload,config});
      if(decision&&decision.actionable){
        suggestionId=suggestions.insert({
          messageId:message.id,
          messageVersion:1,
          kind:'todo',
          title:decision.title,
          summary:decision.summary,
          category:decision.category||classification.category,
          confidence:decision.confidence,
          actionJson:{links},
          status:'pending',
          rationale:decision.rationale,
          model:config.llm?.model||'deepseek-chat',
          createdAt:now
        });
      }
    }
    jobs.complete(job.id,now);
    return {processed:true,jobId:job.id,messageId:message.id,classification,suggestionId,tasks:createdTasks};
  }catch(error){
    const message=String(error.message||error).split('\n')[0].slice(0,200);
    jobs.fail(job.id,message,{now});
    return {processed:true,jobId:job.id,error:message};
  }
}

module.exports={processNextClassifyJob};
