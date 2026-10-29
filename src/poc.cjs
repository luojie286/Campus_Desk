const fs=require('node:fs');
const http=require('node:http');
const crypto=require('node:crypto');
const {openStore,extractLinks,sourceMatches,eventKey,canonicalUrl,findIdentityRow,findHeaderRow,findHeaderRowByContent,findPartialIdentityRow,buildGeneralPlan}=require('./core.cjs');
const {TencentSheet,column}=require('./tencent.cjs');
const {prepareColumnAnalysis,analyzeColumns}=require('./llm.cjs');
fs.mkdirSync('.private',{recursive:true});
const configPath='.private/config.json';
if(!fs.existsSync(configPath)){
  fs.writeFileSync(configPath,JSON.stringify({port:9087,token:crypto.randomBytes(32).toString('hex'),source:{type:'private',id:''},allowed_document:'https://docs.qq.com/sheet/EXAMPLE_DOCUMENT_2',max_rows:6,execute:false},null,2));
}
const config=JSON.parse(fs.readFileSync(configPath));
const store=openStore('.private/poc.sqlite');
const command=process.argv[2]||'status';
let busy=false;
async function processRun(run){
  // 旧账号未完成的记录保留，但不允许新账号执行或核对其写入。
  if(!config.account_id || !run.source_key.startsWith(config.account_id+':'))return;
  // 旧版固定四列流程只处理明确配置的测试表；其他文档先标记 observed，
  // 等通用 analyze / 确认流程处理，避免用四列规则误解任意表格。
  const legacyUrl=config.allowed_document?canonicalUrl(config.allowed_document):null;
  if(run.url!==legacyUrl){store.update(run.id,'observed',null);return;}
  const sheet=new TencentSheet(config);
  try{
    await sheet.open(run.url);
    const profile=store.profile();
    if(run.state==='outcome_unknown'){
      if(await sheet.verify(profile))store.update(run.id,'completed',null);
      else store.update(run.id,'outcome_unknown',null,'manual_reconciliation_required');
      return;
    }
    const plan=await sheet.prepare(profile);
    store.update(run.id,'prepared',plan);
    if(!plan.changes.length){store.update(run.id,'completed',plan);return;}
    if(!config.execute)return;
    if(!await sheet.isEditable())throw Error('document_read_only_or_login_required');
    store.update(run.id,'writing',plan);
    await sheet.apply(plan,profile);
    if(!await sheet.verify(profile))throw Error('readback_mismatch');
    store.update(run.id,'completed',plan);
  }catch(error){
    const current=store.db.prepare('SELECT state FROM runs WHERE id=?').get(run.id);
    // 写入阶段异常不能自动重试；保存错误类别，不输出个人字段与会话。
    store.update(run.id,current.state==='writing'||current.state==='outcome_unknown'?'outcome_unknown':'failed',null,String(error.message).split('\n')[0].slice(0,160));
  }finally{await sheet.close();}
}
async function drain(){
  if(busy)return;busy=true;
  try{for(const run of store.db.prepare("SELECT * FROM runs WHERE state='received' ORDER BY id").all())await processRun(run);}finally{busy=false;}
}
function acceptEvent(e){
  if(!sourceMatches(e,config.source))return {accepted:0,reason:config.source.id?'source_filtered':'source_not_configured'};
  // 来源已由稳定群/成员 ID 过滤；域名和 sheet 路径由 extractLinks/canonicalUrl 限制。
  // 不再要求链接等于单个白名单文档，任意腾讯在线表格链接都先入库等待分析。
  const key=eventKey(e);let accepted=0;
  for(const url of extractLinks(e))accepted+=Number(store.enqueue(key,url));
  return {accepted};
}
// 手动/LLM 写入也留一条 runs 记录；source_key 以 manual: 开头，
// 后台 serve 不会自动重试它，结果不明时必须人工回读。
function startManualRun(url,plan){
  const now=new Date().toISOString();
  const info=store.db.prepare("INSERT INTO runs(source_key,url,state,plan,updated_at) VALUES(?,?,'prepared',?,?)")
    .run('manual:llm:'+now,url,JSON.stringify(plan),now);
  return Number(info.lastInsertRowid);
}
// 先找完整身份；找不到时再尝试“姓名唯一、学号单元格为空”的部分身份。
// 部分身份会在预览中标为 name_only，必须由用户确认后才写入。
function resolveIdentity(grid,profile){
  const full=findIdentityRow(grid,profile);
  if(full)return {identity:full,headerRow:findHeaderRow(grid,full.rowIndex),identityMode:'full'};
  const headerRow=findHeaderRowByContent(grid);
  const partial=findPartialIdentityRow(grid,profile,headerRow);
  if(!partial)return null;
  return {identity:partial,headerRow,identityMode:'name_only'};
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
  else if(command==='analyze'){
    // 只读预览：读取任意腾讯在线表格，用 DeepSeek 映射表头，绝不写入。
    const url=process.argv[3]||config.allowed_document;
    if(!url)throw Error('document_url_required');
    const target=canonicalUrl(url);
    const sheet=new TencentSheet(config);
    try{
      await sheet.open(target);
      const grid=await sheet.readUsedRange();
      const profile=store.profile();
      const fields=store.fields();
      const resolved=resolveIdentity(grid,profile);
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
      const profile=store.profile();
      const fields=store.fields();
      const resolved=resolveIdentity(grid,profile);
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
      runId=startManualRun(target,plan);
      store.update(runId,'writing',plan);
      await sheet.applyGeneral(plan,profile);
      if(!await sheet.verifyGeneral(plan))throw Error('readback_mismatch');
      store.update(runId,'completed',plan);
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
  else if(command==='serve'){
    store.recover();
    const setupNonce=crypto.randomBytes(20).toString('hex');
    const setupBase='/setup/'+setupNonce;
    fs.writeFileSync('.private/setup-url.txt','http://127.0.0.1:'+config.port+setupBase);
    const server=http.createServer(async(req,res)=>{
      res.setHeader('Content-Type','application/json');
      const respond=(status,data)=>{res.statusCode=status;res.end(JSON.stringify(data));};
      if(req.method==='GET'&&req.url?.split('?')[0]===setupBase+'/qr.png'){
        const qr='.private/vendor/napcat-4.18.41/cache/qrcode.png';
        if(!fs.existsSync(qr))return respond(404,{error:'qr_not_ready'});
        res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','image/png');res.end(fs.readFileSync(qr));return;
      }
      if(req.method==='GET'&&req.url===setupBase){
        res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
        res.end(`<!doctype html><meta charset="utf-8"><title>QQ 后台登录</title><h2>手机 QQ 扫码登录后台适配器</h2><p>此二维码每三秒刷新显示；请扫码并在手机确认。</p><img id="qr" width="300" height="300" src="${setupBase}/qr.png"><p>这是本机后台适配器的二维码。腾讯文档需在专用 Edge 中另行登录。</p><script>setInterval(()=>document.getElementById('qr').src='${setupBase}/qr.png?t='+Date.now(),3000)</script>`);return;
      }
      if(req.method==='GET'&&req.url==='/health')return respond(200,{running:true,sourceConfigured:!!config.source.id,busy});
      if(req.method!=='POST'||req.url!=='/onebot')return respond(404,{error:'not_found'});
      let chunks=[],length=0;
      for await(const chunk of req){length+=chunk.length;if(length>262144){respond(413,{error:'event_too_large'});req.destroy();return;}chunks.push(chunk);}
      const body=Buffer.concat(chunks);
      const signature='sha1='+crypto.createHmac('sha1',config.token).update(body).digest('hex');
      const auth=req.headers.authorization==='Bearer '+config.token || req.headers['x-signature']===signature;
      if(!auth)return respond(401,{error:'unauthorized'});
      try{const result=acceptEvent(JSON.parse(body));respond(200,result);setImmediate(()=>drain().catch(()=>{}));}catch{return respond(400,{error:'invalid_event'});}
    });
    server.listen(config.port,'127.0.0.1',()=>console.log('Listening on http://127.0.0.1:'+config.port+'; POST /onebot'));
    setInterval(()=>drain().catch(()=>{}),2000).unref();
  } else throw Error('unknown_command');
}
if(require.main===module)main().catch(e=>{console.error(String(e.message).split('\n')[0]);process.exitCode=1;});
module.exports={acceptEvent};
