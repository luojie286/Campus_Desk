// 附件 worker：下载 -> 校验类型/大小 -> 提取文字 -> 回到会话批次聚合。
// 不打开浏览器；扫描件没有可提取文字时明确标记 empty，不做 OCR、不编造摘要。
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {isSupportedFile}=require('../files/extract.cjs');

const MAX_FILE_BYTES=25*1024*1024;

function conversationDedupeKey({accountRef,conversationType,conversationId}){
  return `suggest:${accountRef}:${conversationType}:${conversationId}`;
}

async function queueConversation(message,messages,jobs,now){
  if(!message)throw Error('message_not_found');
  const cursor=messages.conversationCursor({
    accountRef:message.account_ref,
    conversationType:message.conversation_type,
    conversationId:message.conversation_id
  });
  // 把附件前一条文本也带回批次，方便模型把“说明文字 + 附件”合并为一个事务。
  const before=Math.max(0,Number(message.id)-2);
  if(!cursor||cursor.last_message_id>before){
    messages.setConversationCursor({
      accountRef:message.account_ref,
      conversationType:message.conversation_type,
      conversationId:message.conversation_id,
      lastMessageId:before,
      now
    });
  }
  jobs.enqueueUnique({
    type:'suggest_conversation',
    payload:{
      accountRef:message.account_ref,
      conversationType:message.conversation_type,
      conversationId:message.conversation_id
    },
    runAt:now,
    maxAttempts:3,
    dedupeKey:conversationDedupeKey({
      accountRef:message.account_ref,
      conversationType:message.conversation_type,
      conversationId:message.conversation_id
    })
  });
}

async function processNextFileJob({
  files,
  messages,
  jobs,
  config,
  workerId,
  now=new Date().toISOString(),
  downloadFile,
  extractText,
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

    if(file.text_state==='extracted'&&file.text_path){
      // 之前已经提取过；恢复状态后让会话 worker 重新聚合。
      files.markTextExtracted({id:file.id,textPath:file.text_path,now});
    }else{
      stage='download';
      const buffer=await downloadFile({fileId:file.platform_file_id,fileName:file.file_name,config});
      if(!Buffer.isBuffer(buffer)||!buffer.length)throw Error('file_content_empty');
      if(buffer.length>MAX_FILE_BYTES)throw Error('file_too_large');
      if(!isSupportedFile(file.file_name,file.mime_type)){
        files.markTextUnsupported({id:file.id,reason:'unsupported_file_type',now});
        jobs.complete(job.id,now);
        return {processed:true,jobId:job.id,state:'unsupported'};
      }

      const sha256=crypto.createHash('sha256').update(buffer).digest('hex');
      await fs.mkdir(dir,{recursive:true});
      const extension=path.extname(file.file_name||'').toLowerCase()||'.bin';
      const localPath=path.join(dir,sha256+extension);
      try{await fs.writeFile(localPath,buffer,{flag:'wx'});}
      catch(error){if(error.code!=='EEXIST')throw error;}
      files.markDownloaded({id:file.id,sha256,localPath,sizeBytes:buffer.length,now});

      stage='extract';
      const text=await extractText(buffer,{fileName:file.file_name,mimeType:file.mime_type});
      const clean=String(text||'').replace(/\u0000/g,'').trim();
      if(!clean){
        files.markTextEmpty({id:file.id,now});
        jobs.complete(job.id,now);
        return {processed:true,jobId:job.id,state:'empty'};
      }
      const textPath=path.join(dir,sha256+'.txt');
      await fs.writeFile(textPath,clean.slice(0,200000),'utf8');
      files.markTextExtracted({id:file.id,textPath,now});
    }

    const message=messages.get({id:file.message_id,accountRef:file.account_ref});
    await queueConversation(message,messages,jobs,now);
    jobs.complete(job.id,now);
    return {processed:true,jobId:job.id,state:'queued_for_conversation'};
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
