const fs=require('node:fs');
const http=require('node:http');
const crypto=require('node:crypto');
const path=require('node:path');
const {openStore,extractLinks,eventKey,canonicalUrl,findHeaderRowByContent,buildGeneralPlan,assertWritePreconditions,approvalCheck,digest,placeholderIsPresent,reservationCellEmpty,runBelongsToAccount}=require('./core.cjs');
const {TencentSheet,column}=require('./tencent.cjs');
const {resolveIdentity}=require('./documents/identity.cjs');
const {prepareColumnAnalysis,analyzeColumns}=require('./llm.cjs');
const {backupDatabase}=require('./db/backup.cjs');
const {loadConfig}=require('./config.cjs');
const {applyMigrations}=require('./db/migrate.cjs');
const {createMessageRepository}=require('./db/repositories/messages.cjs');
const {createSuggestionRepository}=require('./db/repositories/suggestions.cjs');
const {createTaskRepository}=require('./db/repositories/tasks.cjs');
const {createJobRepository}=require('./db/repositories/jobs.cjs');
const {createClassificationRepository}=require('./db/repositories/classifications.cjs');
const {createFileRepository}=require('./db/repositories/files.cjs');
const {createSourceRepository}=require('./db/repositories/sources.cjs');
const {createNotificationRepository}=require('./db/repositories/notifications.cjs');
const contacts=require('./contacts/onebot.cjs');
const {ingestEvent}=require('./intake/onebot.cjs');
const {processNextClassifyJob}=require('./worker/classify.cjs');
const {processNextPrepareJob}=require('./worker/prepare.cjs');
const {processNextExecuteJob}=require('./worker/execute.cjs');
const {processNextReconcileJob}=require('./worker/reconcile.cjs');
const {processNextFileJob}=require('./worker/file.cjs');
const {processNextConversationJob}=require('./worker/conversation.cjs');
const {downloadOneBotFile}=require('./files/onebot.cjs');
const {extractFileText}=require('./files/extract.cjs');
const {suggestFromConversation}=require('./suggest/conversation.cjs');
const {createV2Handler}=require('./api/v2.cjs');
const {createBriefingRepository}=require('./briefings/repository.cjs');
const {processBriefing}=require('./briefings/worker.cjs');
const {PREFIX:assistantPrefix,startAssistant}=require('./assistant/api.cjs');
const profiles=require('./documents/profile.cjs');
fs.mkdirSync('.private',{recursive:true});
const configPath='.private/config.json';
if(!fs.existsSync(configPath)){
  fs.writeFileSync(configPath,JSON.stringify({port:9087,token:crypto.randomBytes(32).toString('hex'),source:{type:'private',id:''},allowed_document:'',max_rows:6,execute:false},null,2));
}
// 允许首次运行的空来源配置；非法端口、令牌或来源类型会拒绝启动。
const config=loadConfig(configPath,{allowUnconfigured:true});
const store=openStore('.private/poc.sqlite');
// 增量迁移只新增 v2 表，不修改旧 profile/runs/reservations；每个进程启动时幂等执行。
applyMigrations(store.db);
const messagesRepo=createMessageRepository(store.db);
const tasksRepo=createTaskRepository(store.db);
const suggestionsRepo=createSuggestionRepository(store.db);
const jobsRepo=createJobRepository(store.db);
const classificationsRepo=createClassificationRepository(store.db);
const filesRepo=createFileRepository(store.db);
const sourcesRepo=createSourceRepository(store.db);
const notificationsRepo=createNotificationRepository(store.db);
const briefingsRepo=createBriefingRepository(store.db);
const v2Handler=createV2Handler({messages:messagesRepo,suggestions:suggestionsRepo,tasks:tasksRepo,jobs:jobsRepo,files:filesRepo,sources:sourcesRepo,notifications:notificationsRepo,briefings:briefingsRepo,contacts,config});
const command=process.argv[2]||'status';
let busy=false;
let briefingBusy=false;
async function drainBriefing(){
  if(briefingBusy)return;
  briefingBusy=true;
  try{await processBriefing({db:store.db,briefings:briefingsRepo,accountRef:String(config.account_id||''),config});}
  finally{briefingBusy=false;}
}
// 收到链接后的自动准备：读表、定位身份、调用 DeepSeek、生成计划。
// 该阶段只读，成功后进入 awaiting_approval，等待上层预览确认，不自动写入。
async function prepareGeneralRun(run){
  const sheet=new TencentSheet(config);
  try{
    store.update(run.id,'analyzing',null);
    await sheet.open(run.url);
    const grid=await sheet.readUsedRange();
    const fields=store.fields();
    const reservation=store.reservationFor(run.url);
    const resolved=resolveIdentity(grid,fields,reservation);
    if(!resolved){
      store.update(run.id,'needs_identity',{
        reason:'identity_not_found',rows:grid.length,columns:Math.max(0,...grid.map(row=>row.length))
      },'identity_not_found');
      return;
    }
    const {identity,headerRow}=resolved;
    const payload=prepareColumnAnalysis({grid,identity,headerRow,fields});
    const analysis=await analyzeColumns({payload,config});
    const plan=buildGeneralPlan({grid,identity,headerRow,mappings:analysis.mappings,fields});
    const storedPlan={...plan,confidence:analysis.confidence,notes:analysis.notes,document:run.url};
    storedPlan.profileFingerprint=profiles.fingerprint(storedPlan,fields);
    if(!profiles.planCurrent(storedPlan,store.fields(),[],true))throw Error('profile_changed');
    if(!plan.changes.length&&!plan.missing.length){store.update(run.id,'completed',storedPlan);return;}
    store.update(run.id,'awaiting_approval',storedPlan);
  }catch(error){
    // 分析阶段没有外部写入，失败后允许 reanalyze；错误只保存类别。
    store.update(run.id,'failed',null,String(error.message).split('\n')[0].slice(0,160));
  }finally{await sheet.close();}
}
// 写入中断后的核对：只回读，不自动重试。目标全部一致才标记完成。
async function reconcileGeneralRun(run){
  const sheet=new TencentSheet(config);
  try{
    await sheet.open(run.url);
    const plan=run.plan?JSON.parse(run.plan):null;
    if(!plan||!Array.isArray(plan.changes))throw Error('plan_missing');
    if(await sheet.verifyGeneral(plan))store.update(run.id,'completed',plan);
    else store.update(run.id,'outcome_unknown',null,'manual_reconciliation_required');
  }catch(error){
    store.update(run.id,'outcome_unknown',null,String(error.message).split('\n')[0].slice(0,160));
  }finally{await sheet.close();}
}
async function processRun(run){
  // 旧账号未完成的记录保留，但不允许新账号执行或核对其写入。
  if(!runBelongsToAccount(run,config.account_id))return;
  if(run.state==='outcome_unknown'){await reconcileGeneralRun(run);return;}
  if(run.state!=='received')return;
  await prepareGeneralRun(run);
}
// 上层批准后写入：状态、摘要、execute 开关和串行执行器由调用方共同保证。
async function approveRun(run,expectedDigest){
  // 旧账号或手动记录不能通过 HTTP 审批写入。
  if(!runBelongsToAccount(run,config.account_id))throw Error('account_mismatch');
  const plan=run.plan?JSON.parse(run.plan):null;
  if(!plan)throw Error('plan_missing');
  approvalCheck({state:run.state,digest:digest(plan),expectedDigest,execute:config.execute,busy:false});
  if(plan.warnings&&plan.warnings.length)throw Error('plan_has_warnings');
  if(!Array.isArray(plan.changes)||!plan.changes.length)throw Error('no_changes_to_write');
  // 使用合并后的键值资料，包含 major 等扩展字段；旧 profile 表只有四个基础字段。
  const profile=store.fields();
  const sheet=new TencentSheet(config);
  try{
    await sheet.open(run.url);
    // 先读整表核对身份和目标原值；这一步失败时还没有写入，可保留待审批状态。
    const grid=await sheet.readUsedRange();
    assertWritePreconditions(plan,grid,profile);
    profiles.beginLegacyWrite(store.db,run.id,plan);
    await sheet.applyGeneral(plan,profile);
    if(!await sheet.verifyGeneral(plan))throw Error('readback_mismatch');
    store.update(run.id,'completed',plan);
    // 预约行已替换为真实姓名，预约记录不再需要。
    if(plan.identityMode==='reserved')store.clearReservation(run.url,plan.identityRow);
    return plan;
  }catch(error){
    const current=store.get(run.id);
    if(current&&current.state==='writing')store.update(run.id,'outcome_unknown',null,String(error.message).split('\n')[0].slice(0,160));
    else if(error.message==='profile_changed'){
      if(current?.state==='awaiting_approval')store.update(run.id,'received',null,'profile_changed');
    }else if(current?.state==='awaiting_approval')store.update(run.id,'awaiting_approval',plan,String(error.message).split('\n')[0].slice(0,160));
    throw error;
  }finally{await sheet.close();}
}
async function drain(){
  if(busy)return;busy=true;
  try{for(const run of store.db.prepare("SELECT * FROM runs WHERE state='received' ORDER BY id").all())await processRun(run);}finally{busy=false;}
}
// 分类/候选 worker 只处理消息和候选，不打开浏览器；每个 tick 最多处理三条。
const workerId='serve-'+process.pid;
async function drainClassifyJobs(){
  if(!config.messageCenter)return;
  for(let i=0;i<3;i++){
    const result=await processNextClassifyJob({
      messages:messagesRepo,
      suggestions:suggestionsRepo,
      jobs:jobsRepo,
      classifications:classificationsRepo,
      tasks:tasksRepo,
      config,
      workerId,
      now:new Date().toISOString()
    });
    if(!result.processed)break;
  }
}
// 会话 worker：过滤闲聊，并把同一事务的多条消息合并成一个候选。
async function drainConversationJobs(){
  if(!config.messageCenter)return;
  for(let i=0;i<2;i++){
    const result=await processNextConversationJob({
      messages:messagesRepo,
      suggestions:suggestionsRepo,
      jobs:jobsRepo,
      files:filesRepo,
      config,
      workerId,
      now:new Date().toISOString(),
      suggest:({payload})=>suggestFromConversation({payload,config})
    });
    if(!result.processed)break;
  }
}
// 附件 worker：下载 PDF、提取文字、生成待办候选；不写表格。
async function drainFileJobs(){
  if(!config.messageCenter)return;
  for(let i=0;i<2;i++){
    const result=await processNextFileJob({
      files:filesRepo,
      messages:messagesRepo,
      jobs:jobsRepo,
      notifications:notificationsRepo,
      config,
      workerId,
      now:new Date().toISOString(),
      downloadFile:({fileId,fileName,mimeType})=>downloadOneBotFile({fileId,fileName,mimeType,config}),
      extractText:(buffer,{fileName,mimeType})=>extractFileText(buffer,{fileName,mimeType}),
      dir:'.private/files'
    });
    if(!result.processed)break;
  }
}
// 文档任务准备只读表格并生成审批计划；执行写入仍由后续审批 worker 负责。
async function drainPrepareJobs(){
  if(!config.messageCenter)return;
  for(let i=0;i<2;i++){
    const result=await processNextPrepareJob({
      tasks:tasksRepo,
      jobs:jobsRepo,
      config,
      workerId,
      now:new Date().toISOString(),
      fields:()=>store.fields(),
      reservationFor:url=>store.reservationFor(url),
      createSheet:options=>new TencentSheet(options),
      analyze:({payload})=>analyzeColumns({payload,config})
    });
    if(!result.processed)break;
  }
}
// 审批后的写入只处理 execute_operation；写入异常由 worker 自己进入 outcome_unknown。
async function drainExecuteJobs(){
  if(!config.messageCenter)return;
  for(let i=0;i<1;i++){
    const result=await processNextExecuteJob({
      tasks:tasksRepo,
      jobs:jobsRepo,
      config,
      workerId,
      now:new Date().toISOString(),
      fields:()=>store.fields(),
      createSheet:options=>new TencentSheet(options)
    });
    if(!result.processed)break;
  }
}
// v2 结果未知任务的只读核对；与 legacy 的 `poc.cjs reconcile` 命令互不影响。
async function drainReconcileJobs(){
  if(!config.messageCenter)return;
  for(let i=0;i<1;i++){
    const result=await processNextReconcileJob({
      tasks:tasksRepo,
      jobs:jobsRepo,
      config,
      workerId,
      now:new Date().toISOString(),
      createSheet:options=>new TencentSheet(options)
    });
    if(!result.processed)break;
  }
}
function acceptEvent(e){
  const accountRef=config.account_id?String(config.account_id):'';
  const matched=sourcesRepo.matchEvent(e,{accountRef});
  if(!matched){
    const configured=sourcesRepo.list({accountRef}).length>0;
    return {accepted:0,reason:configured?'source_filtered':'source_not_configured'};
  }
  const source=sourcesRepo.toLegacySource(matched);
  // 消息中心开启时先保存原文并排队分类/候选；这一步不打开浏览器。
  let ingested=null;
  if(config.messageCenter){
    ingested=ingestEvent({event:e,config,messages:messagesRepo,jobs:jobsRepo,files:filesRepo,source});
    if(ingested.reason==='source_filtered')return {accepted:0,reason:'source_filtered'};
    if(ingested.reason==='missing_stable_id')return {accepted:0,reason:'missing_stable_id'};
  }
  // legacy 管道保留现有自动填表行为；v2 管道只存消息和候选，等用户确认待办。
  let accepted=0;
  if(config.pipeline!=='v2'){
    const key=eventKey(e);
    for(const url of extractLinks(e))accepted+=Number(store.enqueue(key,url));
  }
  return {
    accepted,
    stored:ingested?!!ingested.stored:null,
    messageId:ingested?.messageId??null,
    duplicate:ingested?!!ingested.duplicate:null
  };
}
// 手动/LLM 写入也留一条 runs 记录；source_key 以 manual: 开头，
// 后台 serve 不会自动重试它，结果不明时必须人工回读。
function startManualRun(url,plan){
  const now=new Date().toISOString();
  const info=store.db.prepare("INSERT INTO runs(source_key,url,state,plan,updated_at) VALUES(?,?,'prepared',?,?)")
    .run('manual:llm:'+now,url,JSON.stringify(plan),now);
  return Number(info.lastInsertRowid);
}
// 本机上层接口使用与 OneBot 相同的私有令牌；只绑定 127.0.0.1。
function apiAuthorized(req){
  return req.headers.authorization==='Bearer '+config.token;
}
async function readJsonBody(req,max=65536){
  let chunks=[],length=0;
  for await(const chunk of req){length+=chunk.length;if(length>max)throw Error('body_too_large');chunks.push(chunk);}
  if(!length)return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// 预览只返回本次计划，不包含其他同学的行。
function runPreview(run){
  const plan=run.plan?JSON.parse(run.plan):null;
  return {id:run.id,state:run.state,url:run.url,error:run.error,updated_at:run.updated_at,
    digest:plan?digest(plan):null,plan};
}
// 放弃预约：只清除仍等于占位符的姓名单元格；真实姓名或他人内容一律不动。
async function clearReservationPlaceholder(sheet,target,reservation){
  const grid=await sheet.readUsedRange();
  if(!placeholderIsPresent(grid,reservation))throw Error('placeholder_changed');
  const nameCell=column(Number(reservation.name_col))+reservation.row;
  if(!await sheet.clearCell(nameCell))throw Error('clear_not_verified');
  const after=await sheet.readUsedRange();
  if(!reservationCellEmpty(after,reservation))throw Error('clear_not_verified');
  store.clearReservation(target,reservation.row);
  store.abandonReservedRuns(target,reservation.row);
  return nameCell;
}
async function main(){
  if(command==='init-profile'){let data='';for await(const chunk of process.stdin)data+=chunk;const p=JSON.parse(data);if(!p.name||!p.student_id||!p.sex||!Number.isInteger(p.age))throw Error('invalid_profile');store.saveProfile(p);console.log('Profile stored in private SQLite database.');}
  else if(command==='status'){console.log(JSON.stringify({sourceConfigured:!!config.source.id,execute:config.execute,runs:store.summary()},null,2));}
  else if(command==='diagnose'){
    const sheet=new TencentSheet(config);try{await sheet.open(config.allowed_document);const rows=await sheet.readTable();await sheet.page.screenshot({path:'.private/document-diagnostic.png'});console.log(JSON.stringify({header:rows[0],editable:await sheet.isEditable(),loginButtonVisible:await sheet.page.getByRole('button',{name:'登录腾讯文档',exact:true}).isVisible().catch(()=>false),nameBox:await sheet.page.locator('input.bar-label').inputValue()},null,2));}finally{await sheet.close();}
  }
  else if(command==='inspect'){
    const sheet=new TencentSheet(config);try{await sheet.open(config.allowed_document);const plan=await sheet.prepare(store.profile());if(process.argv.includes('--screenshot')){await sheet.select('A1');await sheet.page.screenshot({path:'.private/filled-test-table.png'});}console.log(JSON.stringify({mode:'real_remote_read_only',identityRow:plan.identityRow,changes:plan.changes.map(c=>({cell:require('./tencent.cjs').column(c.col)+c.row,field:c.field,empty:c.before===''})),editable:await sheet.isEditable(),loginButtonVisible:await sheet.page.getByRole('button',{name:'登录腾讯文档',exact:true}).isVisible().catch(()=>false)},null,2));}finally{await sheet.close();}
  }
  else if(command==='profile-set'){
    const key=process.argv[3],value=process.argv.slice(4).join(' ');
    if(!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key||''))throw Error('invalid_field_key');
    if(!value)throw Error('profile_value_required');
    store.setField(key,value,'cli');
    console.log('Profile field stored locally: '+key);
  }
  else if(command==='profile-list'){
    const fields=store.fields();
    const summary=Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{length:String(value).length}]));
    console.log(JSON.stringify({keys:Object.keys(fields).sort(),fields:summary,explicit:store.listFields()},null,2));
  }
  else if(command==='reserve'){
    // 无本人行时，先在你指定行写入可见占位符；这是用户明确授权的提前写入。
    const url=process.argv[3];
    if(!url)throw Error('document_url_required');
    const target=canonicalUrl(url);
    const rowArg=process.argv.indexOf('--row');
    const row=rowArg>=0?Number(process.argv[rowArg+1]):NaN;
    if(!Number.isInteger(row)||row<2)throw Error('reserve_row_required');
    const approved=process.argv.includes('--yes');
    const placeholder='姓名（待补充）';
    const sheet=new TencentSheet(config);
    try{
      await sheet.open(target);
      const grid=await sheet.readUsedRange();
      if(row>grid.length)throw Error('reserve_row_out_of_range');
      const headerRow=findHeaderRowByContent(grid);
      const header=grid[headerRow]||[];
      const nameCols=header.map((value,col)=>({header:String(value).trim(),col}))
        .filter(item=>item.header==='姓名'||item.header==='名字');
      const studentCols=header.map((value,col)=>({header:String(value).trim(),col}))
        .filter(item=>/学号|学生编号|学籍号/.test(item.header));
      if(nameCols.length!==1)throw Error('name_column_not_unique');
      if(studentCols.length!==1)throw Error('student_column_not_unique');
      const nameCol=nameCols[0].col,studentCol=studentCols[0].col;
      const rowCells=grid[row-1]||[];
      const currentName=String(rowCells[nameCol]??'').trim();
      if(currentName!==''&&currentName!==placeholder)throw Error('reserve_name_cell_not_empty');
      if(String(rowCells[studentCol]??'').trim()!=='')throw Error('reserve_student_cell_not_empty');
      const existing=store.reservationFor(target);
      const replace=process.argv.includes('--replace');
      if(existing&&Number(existing.row)!==row&&!replace)throw Error('reservation_exists_on_row_'+existing.row);
      const nameCell=column(nameCol+1)+row;
      const studentCell=column(studentCol+1)+row;
      console.log(JSON.stringify({stage:'reserve_preview',document:target,row,headerRow:headerRow+1,nameCell,studentCell,placeholder,existing_row:existing?Number(existing.row):null,replace,write_requested:approved},null,2));
      if(!approved)return;
      // 放弃旧预约并改选新行时，先安全清除旧占位符，再写新占位符。
      if(existing&&Number(existing.row)!==row&&replace){
        await clearReservationPlaceholder(sheet,target,existing);
      }
      if(currentName!==placeholder){
        await sheet.select(nameCell);
        const editor=sheet.page.locator('#alloy-simple-text-editor');
        await editor.fill(placeholder);
        await editor.press('Enter');
        if((await sheet.readCell(nameCell)).trim()!==placeholder)throw Error('placeholder_write_not_verified');
      }
      store.saveReservation({url:target,header_row:headerRow+1,row,name_col:nameCol+1,student_col:studentCol+1,placeholder});
      console.log(JSON.stringify({stage:'reserved',document:target,row,nameCell,studentCell,placeholder},null,2));
    }finally{await sheet.close();}
  }
  else if(command==='reserve-clear'){
    // 明确放弃一个占位预约：只删除仍等于占位符的单元格，随后清除预约记录。
    const url=process.argv[3];
    if(!url)throw Error('document_url_required');
    const target=canonicalUrl(url);
    const rowArg=process.argv.indexOf('--row');
    const wantedRow=rowArg>=0?Number(process.argv[rowArg+1]):null;
    const approved=process.argv.includes('--yes');
    const reservation=store.reservationFor(target);
    if(!reservation)throw Error('reservation_not_found');
    if(wantedRow!==null&&Number(reservation.row)!==wantedRow)throw Error('reservation_row_mismatch');
    const sheet=new TencentSheet(config);
    try{
      await sheet.open(target);
      const nameCell=column(Number(reservation.name_col))+reservation.row;
      console.log(JSON.stringify({stage:'clear_preview',document:target,row:reservation.row,nameCell,placeholder:reservation.placeholder,write_requested:approved},null,2));
      if(!approved)return;
      const clearedCell=await clearReservationPlaceholder(sheet,target,reservation);
      console.log(JSON.stringify({stage:'cleared',document:target,row:reservation.row,nameCell:clearedCell},null,2));
    }finally{await sheet.close();}
  }
  else if(command==='analyze'){
    // 只读预览：读取任意腾讯在线表格，用 DeepSeek 映射表头，绝不写入。
    const url=process.argv[3]||config.allowed_document;
    if(!url)throw Error('document_url_required');
    const target=canonicalUrl(url);
    const sheet=new TencentSheet(config);
    try{
      await sheet.open(target);
      const grid=await sheet.readUsedRange();
      const fields=store.fields();
      const reservation=store.reservationFor(target);
      const resolved=resolveIdentity(grid,fields,reservation);
      if(!resolved){
        console.log(JSON.stringify({mode:'real_remote_read_only',document:target,status:'identity_not_found',rows:grid.length,columns:Math.max(0,...grid.map(row=>row.length))},null,2));
        process.exitCode=2;return;
      }
      const {identity,headerRow}=resolved;
      const payload=prepareColumnAnalysis({grid,identity,headerRow,fields});
      const analysis=await analyzeColumns({payload,config});
      const plan=buildGeneralPlan({grid,identity,headerRow,mappings:analysis.mappings,fields});
      console.log(JSON.stringify({
        mode:'real_remote_read_only',
        document:target,
        headerRow:plan.headerRow,
        identityRow:plan.identityRow,
        identityMode:plan.identityMode,
        columns:plan.columns.map(item=>({cell:column(item.column)+plan.headerRow,header:item.header,field:item.field})),
        changes:plan.changes.map(item=>({cell:column(item.col)+item.row,field:item.field,before:item.before,value:item.value})),
        missing:plan.missing,
        warnings:plan.warnings,
        confidence:analysis.confidence,
        notes:analysis.notes
      },null,2));
    }finally{await sheet.close();}
  }
  else if(command==='fill'){
    // 默认只预览；确认计划后再加 --yes 真正写入。
    const url=process.argv[3];
    if(!url)throw Error('document_url_required');
    const target=canonicalUrl(url);
    const approved=process.argv.includes('--yes');
    const sheet=new TencentSheet(config);
    let runId=null;
    try{
      await sheet.open(target);
      const grid=await sheet.readUsedRange();
      const fields=store.fields();
      const reservation=store.reservationFor(target);
      const resolved=resolveIdentity(grid,fields,reservation);
      if(!resolved)throw Error('identity_not_found');
      const {identity,headerRow}=resolved;
      const payload=prepareColumnAnalysis({grid,identity,headerRow,fields});
      const analysis=await analyzeColumns({payload,config});
      const plan=buildGeneralPlan({grid,identity,headerRow,mappings:analysis.mappings,fields});
      console.log(JSON.stringify({
        stage:'preview',document:target,headerRow:plan.headerRow,identityRow:plan.identityRow,identityMode:plan.identityMode,
        columns:plan.columns.map(item=>({cell:column(item.column)+plan.headerRow,header:item.header,field:item.field})),
        changes:plan.changes.map(item=>({cell:column(item.col)+item.row,field:item.field,before:item.before,value:item.value})),
        missing:plan.missing,warnings:plan.warnings,confidence:analysis.confidence,write_requested:approved
      },null,2));
      if(!approved)return;
      if(!plan.changes.length){console.log(JSON.stringify({stage:'no_changes'}));return;}
      // 公式起始值需要单独处理，当前不自动写入。
      if(plan.warnings.length)throw Error('plan_has_warnings');
      plan.profileFingerprint=profiles.fingerprint(plan,fields);
      runId=startManualRun(target,plan);
      profiles.beginLegacyWrite(store.db,runId,plan,'prepared');
      await sheet.applyGeneral(plan,fields);
      if(!await sheet.verifyGeneral(plan))throw Error('readback_mismatch');
      store.update(runId,'completed',plan);
      if(plan.identityMode==='reserved')store.clearReservation(target,plan.identityRow);
      console.log(JSON.stringify({stage:'completed',runId,changes:plan.changes.map(item=>({cell:column(item.col)+item.row,field:item.field}))},null,2));
    }catch(error){
      if(runId!==null){
        const current=store.db.prepare('SELECT state FROM runs WHERE id=?').get(runId);
        store.update(runId,current.state==='writing'?'outcome_unknown':'failed',null,String(error.message).split('\n')[0].slice(0,160));
      }
      throw error;
    }finally{await sheet.close();}
  }
  else if(command==='login'){
    const sheet=new TencentSheet(config);await sheet.open(config.allowed_document,true);const loginButton=sheet.page.getByRole('button',{name:'登录腾讯文档',exact:true});if(await loginButton.isVisible())await loginButton.click();console.log('Complete document login manually. The dedicated browser closes gracefully after detecting editable access.');
    // 登录成功后由辅助器自行正常退出，避免强杀导致会话未保存或反复要求登录。
    while(!sheet.page.isClosed()){
      try{if(!await loginButton.isVisible()&&await sheet.isEditable()){await sheet.close();console.log('Authenticated editable session saved.');break;}}
      catch(error){if(sheet.page.isClosed())break;throw error;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  else if(command==='pull-history'){
    if(config.source.type!=='private'||!config.source.id)throw Error('private_source_required');
    async function api(action,body){const r=await fetch('http://127.0.0.1:9088/'+action,{method:'POST',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const j=await r.json();if(!r.ok||j.status!=='ok')throw Error('qq_api_failed_'+action);return j.data;}
    const self=await api('get_login_info',{});
    const history=await api('get_friend_msg_history',{user_id:Number(config.source.id),count:20});
    if(!Array.isArray(history.messages))throw Error('unexpected_history_shape');
    let accepted=0;
    for(const e of history.messages){
      // 保留平台真实 ID、正文与时间；来源明确标为历史拉取，不冒充实时回调。
      if(String(e.user_id??e.sender?.user_id)!==config.source.id)continue;
      accepted+=acceptEvent({...e,post_type:'message',message_type:'private',self_id:self.user_id,user_id:e.user_id??e.sender?.user_id}).accepted;
    }
    const proof={method:'actual_qq_history_api',checkedAt:new Date().toISOString(),fetched:history.messages.length,accepted};
    fs.writeFileSync('.private/history-proof.json',JSON.stringify(proof,null,2));
    fs.appendFileSync('.private/history-proof.jsonl',JSON.stringify(proof)+'\n');
    await drain();console.log(JSON.stringify({method:'actual_qq_history_api',fetched:history.messages.length,accepted,runs:store.summary()},null,2));
  }
  else if(command==='reconcile'){
    for(const run of store.db.prepare("SELECT * FROM runs WHERE state='outcome_unknown'").all())await processRun(run);console.log(JSON.stringify(store.summary(),null,2));
  }
  else if(command==='resume'){
    // 仅恢复未派发写入的准备项；结果未知的记录必须走 reconcile。
    store.db.prepare("UPDATE runs SET state='received',error=NULL WHERE state='prepared' OR (state='failed' AND error IN ('document_read_only_or_login_required','document_login_window_open_close_it_first','unsupported_header'))").run();
    await drain();console.log(JSON.stringify(store.summary(),null,2));
  }
  else if(command==='retry-unwritten'){
    // 仅在明确核对身份与全部原值未变后，允许操作者重试结果未知项。
    for(const run of store.db.prepare("SELECT * FROM runs WHERE state='outcome_unknown'").all()){
      const sheet=new TencentSheet(config);try{
        await sheet.open(run.url);const profile=store.profile(),old=JSON.parse(run.plan),fresh=await sheet.prepare(profile);
        if(fresh.identityRow!==old.identityRow||JSON.stringify(fresh.changes)!==JSON.stringify(old.changes))throw Error('cannot_prove_unwritten');
        store.update(run.id,'received',fresh,'verified_original_values_unchanged');
      }finally{await sheet.close();}
    }
    await drain();console.log(JSON.stringify(store.summary(),null,2));
  }
  else if(command==='backup'){
    // 一致性副本写入 .private/backups，附 integrity 清单；不覆盖已有文件。
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const target=path.join('.private','backups','poc-'+stamp+'.sqlite');
    const manifest=backupDatabase('.private/poc.sqlite',target);
    console.log(JSON.stringify({stage:'backup_complete',target,size:manifest.size,sha256:manifest.sha256,integrity:manifest.integrity},null,2));
  }
  else if(command==='serve'||command==='serve-assistant'){
    const assistantOnly=command==='serve-assistant';
    const assistant=startAssistant({db:store.db,owner:String(config.account_id||''),port:config.port,oldToken:config.token});
    if(assistantOnly&&!assistant)throw Error('assistant_unavailable');
    if(!assistantOnly){
      store.recover();
      jobsRepo.recoverExpired(new Date().toISOString());
    }
    const accountRef=config.account_id?String(config.account_id):'';
    if(!assistantOnly&&accountRef&&sourcesRepo.list({accountRef}).length===0){
      sourcesRepo.seedFromConfig({accountRef,source:config.source,displayName:config.source_name||null});
    }
    if(!assistantOnly&&accountRef)messagesRepo.backfillNames({accountRef});
    const setupNonce=crypto.randomBytes(20).toString('hex');
    const setupBase='/setup/'+setupNonce;
    if(!assistantOnly)fs.writeFileSync('.private/setup-url.txt','http://127.0.0.1:'+config.port+setupBase);
    const server=http.createServer(async(req,res)=>{
      res.setHeader('Content-Type','application/json');
      // Tauri 2 的 WebView 与开发浏览器需要明确允许的本机来源；令牌仍然必需。
      const origin=req.headers.origin;
      const allowedOrigins=new Set(['http://localhost:5173','http://127.0.0.1:5173','http://tauri.localhost','https://tauri.localhost','tauri://localhost']);
      if(origin&&allowedOrigins.has(origin)){
        res.setHeader('Access-Control-Allow-Origin',origin);
        res.setHeader('Vary','Origin');
        res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, PATCH, OPTIONS');
      }
      if(req.method==='OPTIONS'){res.statusCode=204;res.end();return;}
      const respond=(status,data)=>{res.statusCode=status;res.end(JSON.stringify(data));};
      if(!assistantOnly&&req.method==='GET'&&req.url?.split('?')[0]===setupBase+'/qr.png'){
        const qr='.private/vendor/napcat-4.18.41/cache/qrcode.png';
        if(!fs.existsSync(qr))return respond(404,{error:'qr_not_ready'});
        res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','image/png');res.end(fs.readFileSync(qr));return;
      }
      if(!assistantOnly&&req.method==='GET'&&req.url===setupBase){
        res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
        res.end(`<!doctype html><meta charset="utf-8"><title>QQ 后台登录</title><h2>手机 QQ 扫码登录后台适配器</h2><p>此二维码每三秒刷新显示；请扫码并在手机确认。</p><img id="qr" width="300" height="300" src="${setupBase}/qr.png"><p>这是本机后台适配器的二维码。腾讯文档需在专用 Edge 中另行登录。</p><script>setInterval(()=>document.getElementById('qr').src='${setupBase}/qr.png?t='+Date.now(),3000)</script>`);return;
      }
      if(req.method==='GET'&&req.url==='/health')return respond(200,{running:true,sourceConfigured:!!config.source.id,busy});
      const requestUrl=new URL(req.url||'/','http://127.0.0.1');
      const pathname=requestUrl.pathname;
      if(pathname===assistantPrefix||pathname.startsWith(assistantPrefix+'/')){
        if(!assistant)return respond(404,{error:'not_found'});
        return assistant(req,res,requestUrl);
      }
      if(assistantOnly)return respond(404,{error:'not_found'});
      if(pathname.startsWith('/v1/brief')||pathname.startsWith('/v1/messages')||pathname.startsWith('/v1/suggestions')||pathname.startsWith('/v1/todos')||pathname.startsWith('/v1/tasks')||pathname==='/v1/sources'||pathname.startsWith('/v1/listen-sources')||pathname.startsWith('/v1/notifications')||pathname.startsWith('/v1/contacts/')){
        const handled=await v2Handler(req,res,pathname,requestUrl.searchParams);
        if(handled)return;
      }
      if(pathname.startsWith('/v1/')){
        if(!apiAuthorized(req))return respond(401,{error:'unauthorized'});
        if(req.method==='GET'&&pathname==='/v1/runs'){
          const runs=store.db.prepare("SELECT id,state,url,error,updated_at FROM runs ORDER BY id DESC LIMIT 50").all();
          return respond(200,{runs});
        }
        const match=pathname.match(/^\/v1\/runs\/(\d+)(?:\/(approve|reanalyze))?$/);
        if(!match)return respond(404,{error:'not_found'});
        const id=Number(match[1]),action=match[2]||null;
        const run=store.get(id);
        if(!run)return respond(404,{error:'run_not_found'});
        if(req.method==='GET'&&!action)return respond(200,runPreview(run));
        if(req.method==='POST'&&action==='reanalyze'){
          if(!runBelongsToAccount(run,config.account_id))return respond(403,{error:'account_mismatch'});
          if(['writing','outcome_unknown','completed'].includes(run.state))return respond(409,{error:'cannot_reanalyze_in_state_'+run.state});
          store.update(id,'received',null);
          setImmediate(()=>drain().catch(()=>{}));
          return respond(202,{status:'requeued',id});
        }
        if(req.method==='POST'&&action==='approve'){
          if(busy)return respond(409,{error:'busy'});
          let body;
          try{body=await readJsonBody(req);}catch{return respond(400,{error:'invalid_json'});}
          busy=true;
          try{
            const plan=await approveRun(run,body.digest);
            return respond(200,{status:'completed',id,changes:plan.changes.map(item=>({row:item.row,col:item.col,field:item.field}))});
          }catch(error){
            const message=String(error.message).split('\n')[0];
            const status=(message==='execute_disabled'||message==='account_mismatch')?403:
              ['busy','not_awaiting_approval','approval_digest_mismatch','plan_has_warnings','no_changes_to_write','identity_changed','target_changed','profile_changed'].includes(message)?409:500;
            return respond(status,{error:message});
          }finally{busy=false;}
        }
        return respond(405,{error:'method_not_allowed'});
      }
      if(req.method!=='POST'||req.url!=='/onebot')return respond(404,{error:'not_found'});
      let chunks=[],length=0;
      for await(const chunk of req){length+=chunk.length;if(length>262144){respond(413,{error:'event_too_large'});req.destroy();return;}chunks.push(chunk);}
      const body=Buffer.concat(chunks);
      const signature='sha1='+crypto.createHmac('sha1',config.token).update(body).digest('hex');
      const auth=req.headers.authorization==='Bearer '+config.token || req.headers['x-signature']===signature;
      if(!auth)return respond(401,{error:'unauthorized'});
      try{const result=acceptEvent(JSON.parse(body));respond(200,result);setImmediate(()=>drain().catch(()=>{}));}catch{return respond(400,{error:'invalid_event'});}
    });
    server.listen(config.port,'127.0.0.1',()=>console.log('Listening on http://127.0.0.1:'+config.port+(assistantOnly?'; assistant only':'; POST /onebot')));
    if(assistantOnly)return;
    setInterval(()=>drain().catch(()=>{}),2000).unref();
    drainBriefing().catch(()=>{});
    setInterval(()=>drainBriefing().catch(()=>{}),30000).unref();
    if(config.messageCenter){
      setInterval(()=>drainClassifyJobs().catch(()=>{}),2000).unref();
      setInterval(()=>drainConversationJobs().catch(()=>{}),2000).unref();
      setInterval(()=>drainFileJobs().catch(()=>{}),2000).unref();
      setInterval(()=>drainPrepareJobs().catch(()=>{}),2000).unref();
      setInterval(()=>drainExecuteJobs().catch(()=>{}),2000).unref();
      setInterval(()=>drainReconcileJobs().catch(()=>{}),2000).unref();
    }
  } else throw Error('unknown_command');
}
if(require.main===module)main().catch(e=>{console.error(String(e.message).split('\n')[0]);process.exitCode=1;});
module.exports={acceptEvent};
