// Narrow browser adapter for the Python worker. All task state stays in Python.
const {readFileSync}=require('node:fs');
const {loadConfig}=require('../src/config.cjs');
const {canonicalUrl,buildGeneralPlan,assertWritePreconditions,changesMatch,text}=require('../src/core.cjs');
const {resolveIdentity,resolveNewRowIdentity}=require('../src/documents/identity.cjs');
const {prepareColumnAnalysis,analyzeColumns}=require('../src/llm.cjs');
const {loginRequired}=require('../src/documents/login.cjs');
const {TencentSheet}=require('../src/tencent.cjs');
const {DatabaseSync}=require('node:sqlite');
const {existsSync}=require('node:fs');
const {createHash}=require('node:crypto');
const {resolveWorkspace,accountHasHistory}=require('../src/workspace/context.cjs');
const profiles=require('../src/documents/profile.cjs');

const safeErrors=new Set(['login_required','execute_disabled','identity_not_found','identity_conflict',
  'identity_not_unique','identity_columns_ambiguous','identity_changed','target_changed','target_row_changed',
  'target_row_not_empty','header_changed','plan_not_current','plan_has_warnings','profile_missing','profile_changed',
  'placeholder_changed','reserved_student_cell_not_empty','existing_value_conflict','deepseek_api_key_missing',
  'document_read_only_or_login_required','document_login_window_open_close_it_first','write_not_verified','readback_mismatch',
  'sheet_grid_focus_failed','sheet_grid_not_found','clipboard_empty','clipboard_read_failed']);

function identityDigest(plan, grid, changes=[]){
  const values=[plan.nameCol,plan.studentCol].map(col=>{
    const change=changes.find(item=>item.row===plan.identityRow&&item.col===col);
    return text(change?change.value:grid[plan.identityRow-1]?.[col-1]);
  });
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function readback(plan, grid){
  const header=grid[plan.headerRow-1]||[];
  return (plan.columns||[]).every(item=>text(header[item.column-1])===text(item.header))&&
    (!plan.identityReadback||identityDigest(plan,grid)===plan.identityReadback)&&changesMatch(plan,grid);
}

function matchKnownColumns(payload){
  const mappings=[];
  const used=new Set();
  for(const [index,header] of payload.headers.entries()){
    if(!header)continue;
    const matches=payload.fields.filter(field=>field.synonyms.includes(header));
    if(matches.length!==1||used.has(matches[0].key))return null;
    const field=matches[0].key;
    used.add(field);
    mappings.push({column:index+1,field});
  }
  return mappings.length?{mappings,confidence:1,notes:'known_headers'}:null;
}

async function analyzeForPlan({payload,config}){
  // A complete, unambiguous match of known headers requires no model call.
  return matchKnownColumns(payload)||analyzeColumns({payload,config});
}

function verifyGrant(input){
  if(!existsSync('.private/python-business.owner')||
     loadConfig('.private/config.json',{allowUnconfigured:true}).execute!==true)throw Error('execute_disabled');
  const db=new DatabaseSync('.private/poc.sqlite',{readOnly:true});
  try{
    db.exec('BEGIN');
    const workspace=resolveWorkspace(db);
    const row=workspace&&db.prepare(`SELECT t.account_ref,t.todo_id,t.target_ref,p.plan_json,p.digest,p.expires_at
      FROM tasks t JOIN workspace_tasks w ON w.task_id=t.id
      JOIN plans p ON p.id=t.current_plan_id AND p.task_id=t.id
      JOIN operations o ON o.task_id=t.id AND o.plan_id=p.id
      JOIN approvals a ON a.task_id=t.id AND a.plan_id=p.id AND a.plan_version=p.version AND a.plan_digest=p.digest
      WHERE w.workspace_id=? AND t.id=? AND t.state='executing' AND p.status='current'
      AND o.id=? AND o.state='running' AND a.decision='approved'`).get(workspace.id,input.task_id,input.operation_id);
    if(!row||row.target_ref!==input.target||createHash('sha256').update(row.plan_json).digest('hex')!==row.digest||
       JSON.stringify(JSON.parse(row.plan_json))!==JSON.stringify(input.plan)||
       (row.expires_at&&row.expires_at<=new Date().toISOString())||
       (row.account_ref!==workspace.id&&!accountHasHistory(db,row.account_ref,workspace)))throw Error('plan_not_current');
    if(row.todo_id&&!db.prepare(`SELECT 1 FROM todos t WHERE t.id=? AND t.status<>'deleted'
      AND EXISTS(SELECT 1 FROM todo_messages x WHERE x.todo_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM todo_messages x LEFT JOIN messages m ON m.id=x.message_id WHERE x.todo_id=t.id
       AND NOT EXISTS(SELECT 1 FROM workspace_source_bindings b WHERE b.workspace_id=?
        AND b.provider=m.platform AND b.account_ref=m.account_ref AND b.history_allowed=1))`).get(row.todo_id,workspace.id))
      throw Error('plan_not_current');
    const fields=profiles.fields(db), answers=db.prepare(
      'SELECT key,value FROM task_answers WHERE task_id=? ORDER BY task_version,key').all(input.task_id);
    if(!profiles.planCurrent(input.plan,fields,answers,true)||
       profiles.fingerprint(input.plan,input.profile)!==input.plan.profileFingerprint)throw Error('profile_changed');
  }finally{db.close();}
}

async function run(input, config, createSheet=()=>new TencentSheet(config), analyze=analyzeForPlan, verify=()=>{}){
  let attempted=false, sheet;
  try{
    if(!['prepare','execute','reconcile','probe'].includes(input.action))throw Error('plan_not_current');
    const url=canonicalUrl(input.target);
    if(['prepare','execute'].includes(input.action)&&(!input.profile?.name||!input.profile?.student_id))throw Error('profile_missing');
    if(input.action==='execute'&&config.execute!==true)throw Error('execute_disabled');
    const plan=input.plan;
    if(['execute','reconcile'].includes(input.action)&&(!plan||!Array.isArray(plan.changes)||!plan.changes.length||
        plan.document!==url))throw Error('plan_not_current');
    if(input.action==='execute'&&(plan.missing?.length||plan.warnings?.length||
       plan.changes.some(item=>/^[=+\-@]/.test(item.value))))throw Error('plan_has_warnings');
    sheet=createSheet();
    await sheet.open(url);
    if(await loginRequired(sheet))throw Error('login_required');
    const actual=canonicalUrl(sheet.page?.url()||url);
    if(new URL(actual).pathname!==new URL(url).pathname||
       (new URL(url).searchParams.has('tab')&&actual!==url))throw Error('target_changed');
    const grid=await sheet.readUsedRange();
    if(input.action==='probe')return {ok:true,readable:grid.length>0,editable:await sheet.isEditable()};
    if(input.action==='prepare'){
      const resolved=resolveIdentity(grid,input.profile,input.reservation)||resolveNewRowIdentity(grid);
      if(!resolved)throw Error('identity_not_found');
      const {identity,headerRow}=resolved;
      const payload=prepareColumnAnalysis({grid,identity,headerRow,fields:input.profile});
      const analysis=await analyze({payload,config});
      const prepared=buildGeneralPlan({grid,identity,headerRow,mappings:analysis.mappings,fields:input.profile});
      prepared.identityReadback=identityDigest(prepared,grid,prepared.changes);
      return {ok:true,plan:{...prepared,confidence:analysis.confidence,notes:analysis.notes,document:url,sheetLocation:actual}};
    }
    if(plan.sheetLocation&&actual!==plan.sheetLocation)throw Error('target_changed');
    const header=grid[plan.headerRow-1]||[];
    if((plan.columns||[]).some(item=>text(header[item.column-1])!==text(item.header)))throw Error('header_changed');
    if(input.action==='reconcile')return {ok:true,matched:readback(plan,grid)};
    assertWritePreconditions(plan,grid,input.profile);
    verify(input);
    attempted=true;
    await sheet.applyGeneral(plan,input.profile);
    // Reopen in a fresh context before verifying the persisted cells.
    await sheet.close();
    sheet=createSheet();
    await sheet.open(url);
    if(await loginRequired(sheet)||canonicalUrl(sheet.page?.url()||url)!==actual)throw Error('readback_mismatch');
    const matched=readback(plan,await sheet.readUsedRange());
    return {ok:true,matched};
  }catch(error){
    return {ok:false,attempted,code:safeErrors.has(error.message)?error.message:'sheet_adapter_failed'};
  }finally{
    if(sheet)try{await sheet.close();}catch{}
  }
}

if(require.main===module){
  (async()=>{
    const input=JSON.parse(readFileSync(0,'utf8'));
    const config=loadConfig('.private/config.json',{allowUnconfigured:true});
    process.stdout.write(JSON.stringify(await run(input,config,undefined,undefined,verifyGrant)));
  })().catch(()=>{process.stdout.write(JSON.stringify({ok:false,attempted:false,code:'sheet_adapter_failed'}));});
}
module.exports={run};
