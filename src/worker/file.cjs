// 附件 worker：下载 -> 校验类型/大小 -> 提取文字 -> 生成待办候选。
// 不打开浏览器；扫描件没有可提取文字时明确标记 empty，不做 OCR、不编造摘要。
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {buildSuggestionPayload}=require('../suggest/llm.cjs');

const MAX_FILE_BYTES=25*1024*1024;

function linksOf(message){
  try{return JSON.parse(message.link_json||'[]');}catch{return [];}
}

async function processNextFileJob({
  files,
  messages,
  suggestions,
  jobs,
  config,
  workerId,
  now=new Date().toISOString(),
  downloadFile,
  extractText,
  suggest,
  dir='.private/files'
}){
  const job=jobs.claim({workerId,leaseSeconds:120,now,type:'process_file'});
  if(!job)return {processed:false};
  let file=null;
  let stage='load';
  try{
    const jobPayload=JSON.parse(job.payload_json||'{}');
    file=files.get({id:jobPayload.fileId,accountRef:jobPayload.accountRef});
    if(!file)throw Error('file_not_found');
    if(file.text_state==='empty'||file.text_state==='unsupported'){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:file.text_state};
    }

    let text=null;
    if(file.text_state==='extracted'&&file.text_path){
      stage='suggest';
      // 之前可能已经下载过但状态被旧失败覆盖；这里恢复为 extracted/downloaded。
      files.markTextExtracted({id:file.id,textPath:file.text_path,now});
      text=await fs.readFile(file.text_path,'utf8');
    }else{
      stage='download';
      const buffer=await downloadFile({fileId:file.platform_file_id,fileName:file.file_name,config});
      if(!Buffer.isBuffer(buffer)||!buffer.length)throw Error('file_content_empty');
      if(buffer.length>MAX_FILE_BYTES)throw Error('file_too_large');
      const extension=path.extname(file.file_name||'').toLowerCase();
      const mime=String(file.mime_type||'').toLowerCase();
      if(extension!=='.pdf'&&mime!=='application/pdf'){
        files.markTextUnsupported({id:file.id,reason:'unsupported_file_type',now});
        jobs.complete(job.id,now);
        return {processed:true,jobId:job.id,state:'unsupported'};
      }

      const sha256=crypto.createHash('sha256').update(buffer).digest('hex');
      await fs.mkdir(dir,{recursive:true});
      const localPath=path.join(dir,sha256+'.pdf');
      try{await fs.writeFile(localPath,buffer,{flag:'wx'});}
      catch(error){if(error.code!=='EEXIST')throw error;}
      files.markDownloaded({id:file.id,sha256,localPath,sizeBytes:buffer.length,now});

      stage='extract';
      text=await extractText(buffer,{fileName:file.file_name});
      const clean=String(text||'').replace(/\u0000/g,'').trim();
      if(!clean){
        files.markTextEmpty({id:file.id,now});
        jobs.complete(job.id,now);
        return {processed:true,jobId:job.id,state:'empty'};
      }
      const textPath=path.join(dir,sha256+'.txt');
      await fs.writeFile(textPath,clean.slice(0,200000),'utf8');
      files.markTextExtracted({id:file.id,textPath,now});
      text=clean;
    }

    stage='suggest';
    const existing=suggestions.listForMessage({messageId:file.message_id,accountRef:file.account_ref});
    if(existing.length){
      jobs.complete(job.id,now);
      return {processed:true,jobId:job.id,state:'already_suggested'};
    }
    const message=messages.get({id:file.message_id,accountRef:file.account_ref});
    if(!message)throw Error('message_not_found');
    const payload=buildSuggestionPayload({
      message:{
        contentText:[message.content_text,String(text||'').slice(0,12000)].filter(Boolean).join('\n\n[附件文字]\n'),
        links:linksOf(message)
      },
      classification:{category:'file',confidence:0.8,rule:'pdf_text'}
    });
    const decision=await suggest({payload,config});
    let suggestionId=null;
    if(decision&&decision.actionable){
      suggestionId=suggestions.insert({
        messageId:message.id,
        messageVersion:1,
        kind:'todo',
        title:decision.title,
        summary:decision.summary,
        category:decision.category||'file',
        confidence:decision.confidence,
        actionJson:{links:linksOf(message)},
        status:'pending',
        rationale:decision.rationale,
        model:config.llm?.model||'deepseek-chat',
        createdAt:now
      });
    }
    jobs.complete(job.id,now);
    return {processed:true,jobId:job.id,state:suggestionId?'suggested':'not_actionable',suggestionId};
  }catch(error){
    const message=String(error.message||error).split('\n')[0].slice(0,200);
    if(file){
      // 按失败阶段回写，避免摘要失败时把已经成功的下载/提取状态覆盖掉。
      if(stage==='download')files.markDownloadFailed({id:file.id,error:message,now});
      else if(stage==='extract')files.markTextFailed({id:file.id,error:message,now});
    }
    jobs.fail(job.id,message,{now});
    return {processed:true,jobId:job.id,error:message};
  }
}

module.exports={processNextFileJob,MAX_FILE_BYTES};
