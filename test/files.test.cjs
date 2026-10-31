const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createMessageRepository}=require('../src/db/repositories/messages.cjs');
const {createSuggestionRepository}=require('../src/db/repositories/suggestions.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');
const {createFileRepository}=require('../src/db/repositories/files.cjs');
const {ingestEvent}=require('../src/intake/onebot.cjs');
const {processNextFileJob}=require('../src/worker/file.cjs');

const now='2026-10-30T11:00:00.000Z';
const testDir=fs.mkdtempSync(path.join(os.tmpdir(),'campus-desk-files-'));
after(()=>fs.rmSync(testDir,{recursive:true,force:true}));
const config={
  account_id:'7007',adapter_instance:'onebot-main',
  source:{type:'group',id:'6318',sender_id:'1278',account_id:'7007'}
};
const baseMessage={
  platform:'qq',adapterInstance:'onebot-main',accountRef:'7007',conversationType:'group',
  conversationId:'6318',senderId:'1278',sourceTime:now,receivedAt:now,kind:'file',
  contentText:'请查看附件',contentJson:null,linkJson:'[]',completeness:'full',
  identityQuality:'stable_id',rawJson:'{}'
};
function setup(){
  const store=openStore(':memory:');
  applyMigrations(store.db);
  return {
    store,
    messages:createMessageRepository(store.db),
    suggestions:createSuggestionRepository(store.db),
    jobs:createJobRepository(store.db),
    files:createFileRepository(store.db)
  };
}
test('files: a OneBot file segment is stored and queued without downloading in intake',()=>{
  const {store,messages,jobs,files}=setup();
  const event={
    post_type:'message',message_type:'group',self_id:7007,group_id:6318,user_id:1278,
    message_id:101,time:1790000000,
    message:[
      {type:'text',data:{text:'请查看附件'}},
      {type:'file',data:{file_id:'file-1',file:'通知.pdf',file_size:'1234'}}
    ]
  };
  const result=ingestEvent({event,config,messages,jobs,files,now});
  assert.equal(result.stored,true);
  const message=messages.get({id:result.messageId,accountRef:'7007'});
  assert.equal(message.kind,'file');
  const rows=files.listForMessage({messageId:result.messageId,accountRef:'7007'});
  assert.equal(rows.length,1);
  assert.equal(rows[0].file_name,'通知.pdf');
  assert.equal(rows[0].download_state,'pending');
  const queued=store.db.prepare("SELECT * FROM jobs WHERE type='process_file'").all();
  assert.equal(queued.length,1);
  assert.equal(JSON.parse(queued[0].payload_json).fileId,rows[0].id);
  store.db.close();
});
test('files: PDF text is extracted and queued back into conversation aggregation',async()=>{
  const {store,messages,suggestions,jobs,files}=setup();
  const message=messages.insert({...baseMessage,sourceMessageId:'m-file'});
  const file=files.insert({
    messageId:message.id,accountRef:'7007',platformFileId:'file-1',fileName:'通知.pdf',
    mimeType:'application/pdf',sizeBytes:1234,createdAt:now
  });
  jobs.enqueue({type:'process_file',payload:{fileId:file.id,messageId:message.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const result=await processNextFileJob({
    files,messages,jobs,config,workerId:'w1',now,
    downloadFile:async()=>Buffer.from('%PDF-1.4 fake'),
    extractText:async()=>'报名通知：学号 202500000000 的同学请于周五前提交材料。',
    dir:testDir
  });
  assert.equal(result.processed,true);
  assert.equal(result.state,'queued_for_conversation');
  const current=files.get({id:file.id,accountRef:'7007'});
  assert.equal(current.download_state,'downloaded');
  assert.equal(current.text_state,'extracted');
  assert.equal(current.sha256.length,64);
  assert.equal(suggestions.listForMessage({messageId:message.id,accountRef:'7007'}).length,0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='suggest_conversation'").get().n,1);
  store.db.close();
});
test('files: DOCX files use the same download, extraction and conversation handoff',async()=>{
  const {store,messages,jobs,files}=setup();
  const message=messages.insert({...baseMessage,sourceMessageId:'m-docx'});
  const file=files.insert({
    messageId:message.id,accountRef:'7007',platformFileId:'file-docx',fileName:'通知.docx',
    mimeType:null,sizeBytes:2048,createdAt:now
  });
  jobs.enqueue({type:'process_file',payload:{fileId:file.id,messageId:message.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const result=await processNextFileJob({
    files,messages,jobs,config,workerId:'w1',now,
    downloadFile:async()=>Buffer.from('fake-docx'),
    extractText:async()=>'Word 通知正文：请提交推荐表。',
    dir:testDir
  });
  assert.equal(result.processed,true);
  assert.equal(result.state,'queued_for_conversation');
  assert.equal(files.get({id:file.id,accountRef:'7007'}).text_state,'extracted');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='suggest_conversation'").get().n,1);
  store.db.close();
});
test('files: an already extracted file recovers from a stale failure state',async()=>{
  const {store,messages,jobs,files}=setup();
  const message=messages.insert({...baseMessage,sourceMessageId:'m-recover'});
  const file=files.insert({
    messageId:message.id,accountRef:'7007',platformFileId:'file-3',fileName:'通知.pdf',
    mimeType:'application/pdf',sizeBytes:1234,createdAt:now
  });
  const textPath=path.join(testDir,'recovered.txt');
  fs.writeFileSync(textPath,'通知正文', 'utf8');
  store.db.prepare("UPDATE message_files SET text_state='extracted',download_state='failed',error='fetch failed',text_path=? WHERE id=?")
    .run(textPath,file.id);
  jobs.enqueue({type:'process_file',payload:{fileId:file.id,messageId:message.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const result=await processNextFileJob({
    files,messages,jobs,config,workerId:'w1',now,
    downloadFile:async()=>{throw Error('should_not_download');},
    extractText:async()=>{throw Error('should_not_extract');},
    dir:testDir
  });
  assert.equal(result.processed,true);
  assert.equal(result.state,'queued_for_conversation');
  const current=files.get({id:file.id,accountRef:'7007'});
  assert.equal(current.text_state,'extracted');
  assert.equal(current.download_state,'downloaded');
  assert.equal(current.error,null);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='suggest_conversation'").get().n,1);
  store.db.close();
});
test('files: a PDF with no extractable text is marked empty and creates no candidate',async()=>{
  const {store,messages,suggestions,jobs,files}=setup();
  const message=messages.insert({...baseMessage,sourceMessageId:'m-scan'});
  const file=files.insert({
    messageId:message.id,accountRef:'7007',platformFileId:'file-2',fileName:'扫描件.pdf',
    mimeType:'application/pdf',sizeBytes:1234,createdAt:now
  });
  jobs.enqueue({type:'process_file',payload:{fileId:file.id,messageId:message.id,accountRef:'7007'},runAt:now,maxAttempts:1});
  const result=await processNextFileJob({
    files,messages,jobs,config,workerId:'w1',now,
    downloadFile:async()=>Buffer.from('%PDF-1.4 fake'),
    extractText:async()=>'   ',
    dir:testDir
  });
  assert.equal(result.processed,true);
  assert.equal(result.state,'empty');
  assert.equal(files.get({id:file.id,accountRef:'7007'}).text_state,'empty');
  assert.equal(suggestions.listForMessage({messageId:message.id,accountRef:'7007'}).length,0);
  store.db.close();
});
