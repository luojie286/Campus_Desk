const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseTsv,findIdentityRow,findHeaderRow,findHeaderRowByContent,findPartialIdentityRow,findReservedIdentity,buildGeneralPlan,openStore,assertWritePreconditions,changesMatch,approvalCheck,digest,placeholderIsPresent,reservationCellEmpty,runBelongsToAccount}=require('../src/core.cjs');
const {prepareColumnAnalysis,validateLlmMapping,analyzeColumns}=require('../src/llm.cjs');
const p={name:'测试甲',student_id:'00123',sex:'男',age:'19',phone:'13800000000',major:'计算机科学与技术'};

test('profile fields: key-value fields merge legacy profile without overwriting explicit values',()=>{
  const s=openStore(':memory:');s.saveProfile(p);
  assert.equal(s.fields().name,'测试甲');
  assert.equal(s.fields().age,'19');
  s.setField('phone','13900000000');
  assert.equal(s.fields().phone,'13900000000');
  s.setField('name','显式覆盖');
  assert.equal(s.fields().name,'显式覆盖');
  assert.equal(s.listFields().some(item=>item.key==='phone'&&item.value_length===11),true);
  s.db.close();
});
test('account isolation: only runs under the active account can be approved or reanalyzed',()=>{
  assert.equal(runBelongsToAccount({source_key:'7007:group:6318:m1'},'7007'),true);
  assert.equal(runBelongsToAccount({source_key:'9000000005:group:6318:m1'},'7007'),false);
  assert.equal(runBelongsToAccount({source_key:'manual:llm:1'},'7007'),false);
  assert.equal(runBelongsToAccount({source_key:'7007:group:6318:m1'},''),false);
});
test('approval: requires awaiting state, matching digest, execute enabled and no busy executor',()=>{
  const plan={changes:[{row:3,col:3,field:'sex',value:'男'}]};
  const d=digest(plan);
  assert.equal(approvalCheck({state:'awaiting_approval',digest:d,expectedDigest:d,execute:true,busy:false}),true);
  assert.throws(()=>approvalCheck({state:'completed',digest:d,expectedDigest:d,execute:true,busy:false}),/not_awaiting_approval/);
  assert.throws(()=>approvalCheck({state:'awaiting_approval',digest:d,expectedDigest:d,execute:false,busy:false}),/execute_disabled/);
  assert.throws(()=>approvalCheck({state:'awaiting_approval',digest:'x',expectedDigest:d,execute:true,busy:false}),/approval_digest_mismatch/);
  assert.throws(()=>approvalCheck({state:'awaiting_approval',digest:d,expectedDigest:d,execute:true,busy:true}),/busy/);
});
test('database: get returns a run by id and recover requeues interrupted analysis',()=>{
  const s=openStore(':memory:');
  s.enqueue('source:1','https://docs.qq.com/sheet/abc');
  assert.equal(s.get(1).state,'received');
  s.db.prepare("UPDATE runs SET state='analyzing' WHERE id=1").run();
  s.recover();
  assert.equal(s.get(1).state,'received');
  s.db.close();
});
test('tsv: parse quoted tabs, newlines and escaped quotes, dropping trailing empty rows',()=>{
  assert.deepEqual(parseTsv('姓名\t学号\n测试甲\t00123\n'),[['姓名','学号'],['测试甲','00123']]);
  assert.deepEqual(parseTsv('a\t"line1\nline2"\n'),[['a','line1\nline2']]);
  assert.deepEqual(parseTsv('a\t"say ""hi"""\n'),[['a','say "hi"']]);
  assert.deepEqual(parseTsv('a\t\tb\n'),[['a','','b']]);
});
test('identity: locate one row by exact name and student id, reject ambiguity',()=>{
  const grid=[['说明'],['姓名','学号'],['测试甲','00124'],['测试甲','00123']];
  assert.deepEqual(findIdentityRow(grid,p),{rowIndex:3,nameCol:0,studentCol:1});
  assert.equal(findIdentityRow([['姓名','学号'],['别人','00123']],p),null);
  assert.throws(()=>findIdentityRow([...grid,grid[3]],p),/identity_not_unique/);
  assert.throws(()=>findIdentityRow([['姓名','学号'],['测试甲','测试甲','00123']],p),/identity_columns_ambiguous/);
});
test('header: choose the nearest row above identity with at least two non-empty cells',()=>{
  assert.equal(findHeaderRow([['说明'],['姓名','学号','性别'],['测试甲','00123','男']],2),1);
  assert.throws(()=>findHeaderRow([['说明'],['测试甲','00123']],1),/header_not_found/);
});
test('plan: map arbitrary columns and only fill empty cells in the own row',()=>{
  const grid=[
    ['姓名','学号','性别','年龄','手机号','备注'],
    ['其他人','99999','女','20','13900000000','不应被使用'],
    ['测试甲','00123','','','','']
  ];
  const identity=findIdentityRow(grid,p);
  const mappings=[
    {column:1,field:'name'},{column:2,field:'student_id'},{column:3,field:'sex'},
    {column:4,field:'age'},{column:5,field:'phone'}
  ];
  const plan=buildGeneralPlan({grid,identity,headerRow:0,mappings,fields:p});
  assert.equal(plan.headerRow,1);
  assert.equal(plan.identityRow,3);
  assert.deepEqual(plan.changes.map(c=>[c.row,c.col,c.field]),[[3,3,'sex'],[3,4,'age'],[3,5,'phone']]);
  assert.deepEqual(plan.missing,[]);
  assert.equal(plan.columns.length,5);
});
test('plan: stop on conflicting existing values and reject unsafe mappings',()=>{
  const grid=[['姓名','学号','性别'],['测试甲','00123','女']];
  const identity=findIdentityRow(grid,p);
  assert.throws(()=>buildGeneralPlan({grid,identity,headerRow:0,mappings:[{column:3,field:'sex'}],fields:p}),/existing_value_conflict/);
  assert.throws(()=>buildGeneralPlan({grid,identity,headerRow:0,mappings:[{column:9,field:'sex'}],fields:p}),/mapping_out_of_range/);
  assert.throws(()=>buildGeneralPlan({grid,identity,headerRow:0,mappings:[{column:3,field:'unknown'}],fields:p}),/unknown_profile_field/);
  assert.throws(()=>buildGeneralPlan({grid,identity,headerRow:0,mappings:[{column:1,field:'sex'}],fields:p}),/identity_column_mismatch/);
});
test('partial identity: unique name with an empty student-id cell is usable for preview and fill',()=>{
  const grid=[['姓名','年龄','学号','性别'],['别人','20','999','女'],['测试甲','','','']];
  const headerRow=findHeaderRowByContent(grid);
  assert.equal(headerRow,0);
  const identity=findPartialIdentityRow(grid,p,headerRow);
  assert.deepEqual(identity,{rowIndex:2,nameCol:0,studentCol:2,mode:'name_only'});
  const mappings=[{column:1,field:'name'},{column:2,field:'age'},{column:3,field:'student_id'},{column:4,field:'sex'}];
  const plan=buildGeneralPlan({grid,identity,headerRow,mappings,fields:p});
  assert.equal(plan.identityMode,'name_only');
  assert.deepEqual(plan.changes.map(item=>[item.row,item.col,item.field]),[[3,2,'age'],[3,3,'student_id'],[3,4,'sex']]);
  assert.equal(assertWritePreconditions(plan,grid,p),true);
  assert.throws(()=>findPartialIdentityRow([...grid,grid[2]],p,headerRow),/identity_not_unique/);
});
test('reserved row: placeholder is replaced by the real name and only that row is filled',()=>{
  const grid=[
    ['分区','姓名','学号','专业'],
    ['网安楼','姓名（待补充）','',''],
    ['网安楼','','','']
  ];
  const reservation={url:'https://docs.qq.com/sheet/x',header_row:1,row:2,name_col:2,student_col:3,placeholder:'姓名（待补充）'};
  const identity=findReservedIdentity(grid,p,reservation);
  assert.deepEqual(identity,{rowIndex:1,nameCol:1,studentCol:2,mode:'reserved',placeholder:'姓名（待补充）'});
  const mappings=[{column:2,field:'name'},{column:3,field:'student_id'},{column:4,field:'major'}];
  const plan=buildGeneralPlan({grid,identity,headerRow:0,mappings,fields:p});
  assert.equal(plan.identityMode,'reserved');
  assert.deepEqual(plan.changes.map(item=>[item.row,item.col,item.field,item.before,item.value]),[
    [2,2,'name','姓名（待补充）','测试甲'],
    [2,3,'student_id','','00123'],
    [2,4,'major','','计算机科学与技术']
  ]);
  assert.equal(assertWritePreconditions(plan,grid,p),true);
  const changed=[['分区','姓名','学号','专业'],['网安楼','别人','','']];
  assert.throws(()=>findReservedIdentity(changed,p,reservation),/placeholder_changed/);
  assert.throws(()=>buildGeneralPlan({grid,identity,headerRow:0,mappings:[{column:3,field:'student_id'},{column:4,field:'major'}],fields:p}),/name_mapping_missing/);
});
test('reservation cleanup: only clear a cell that still contains our placeholder',()=>{
  const grid=[['分区','姓名','学号','专业'],['网安楼','姓名（待补充）','','']];
  const r={row:2,name_col:2,placeholder:'姓名（待补充）'};
  assert.equal(placeholderIsPresent(grid,r),true);
  assert.equal(reservationCellEmpty(grid,r),false);
  const cleared=[['分区','姓名','学号','专业'],['网安楼','','','']];
  assert.equal(placeholderIsPresent(cleared,r),false);
  assert.equal(reservationCellEmpty(cleared,r),true);
  const renamed=[['分区','姓名','学号','专业'],['网安楼','示例学生','','']];
  assert.equal(placeholderIsPresent(renamed,r),false);
});
test('reservations: abandoning marks matching awaiting runs abandoned',()=>{
  const s=openStore(':memory:');
  s.enqueue('source:1','https://docs.qq.com/sheet/x');
  s.update(1,'awaiting_approval',{identityMode:'reserved',identityRow:2});
  s.abandonReservedRuns('https://docs.qq.com/sheet/x',2);
  assert.equal(s.get(1).state,'abandoned');
  s.db.close();
});
test('reservations: save, look up by url and clear by url/row',()=>{
  const s=openStore(':memory:');
  s.saveReservation({url:'https://docs.qq.com/sheet/x',header_row:1,row:2,name_col:2,student_col:3,placeholder:'姓名（待补充）'});
  assert.equal(s.reservationFor('https://docs.qq.com/sheet/x').row,2);
  s.clearReservation('https://docs.qq.com/sheet/x',2);
  assert.equal(s.reservationFor('https://docs.qq.com/sheet/x'),null);
  s.db.close();
});
test('write preconditions: re-check identity and empty targets before any write',()=>{
  const grid=[['姓名','学号','性别'],['测试甲','00123','']];
  const identity=findIdentityRow(grid,p);
  const plan=buildGeneralPlan({grid,identity,headerRow:0,mappings:[{column:3,field:'sex'}],fields:p});
  assert.equal(assertWritePreconditions(plan,grid,p),true);
  assert.equal(changesMatch(plan,grid),false);
  const filled=[['姓名','学号','性别'],['测试甲','00123','男']];
  // 写入前要求目标仍为空；写入后才用 changesMatch 确认值。
  assert.throws(()=>assertWritePreconditions(plan,filled,p),/target_changed/);
  assert.equal(changesMatch(plan,filled),true);
  const shifted=[['说明'],['姓名','学号','性别'],['测试甲','00123','']];
  assert.throws(()=>assertWritePreconditions(plan,shifted,p),/identity_changed/);
});
test('privacy: llm payload contains headers and own row only, never other rows',()=>{
  const grid=[['姓名','学号','性别'],['其他人','99999','女'],['测试甲','00123','']];
  const payload=prepareColumnAnalysis({grid,identity:findIdentityRow(grid,p),headerRow:0,fields:p});
  const text=JSON.stringify(payload);
  assert.equal(text.includes('其他人'),false);
  assert.equal(text.includes('99999'),false);
  assert.equal(text.includes('00123'),true);
  assert.equal(text.includes('13800000000'),false);
  assert.deepEqual(payload.headers,['姓名','学号','性别']);
  assert.deepEqual(payload.ownRow,['测试甲','00123','']);
  assert.equal(payload.fields.some(f=>f.key==='phone'),true);
});
test('llm mapping: reject values, unknown fields, duplicate fields and out-of-range columns',()=>{
  const opts={headerCount:3,fields:p,identityColumns:{name:1,studentId:2}};
  assert.deepEqual(validateLlmMapping({columns:[{column:3,field:'sex'}]},opts),[ {column:3,field:'sex'} ]);
  assert.throws(()=>validateLlmMapping({columns:[{column:3,field:'sex',value:'女'}]},opts),/llm_must_not_supply_values/);
  assert.throws(()=>validateLlmMapping({columns:[{column:3,field:'unknown'}]},opts),/unknown_profile_field/);
  assert.throws(()=>validateLlmMapping({columns:[{column:3,field:'sex'},{column:4,field:'sex'}]},{...opts,headerCount:4}),/duplicate_field/);
  assert.throws(()=>validateLlmMapping({columns:[{column:9,field:'sex'}]},opts),/mapping_out_of_range/);
});
test('llm call: send only prepared payload and parse a validated mapping',async()=>{
  const calls=[];
  const fakeFetch=async(url,options)=>{
    calls.push({url,options});
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({columns:[{column:3,field:'sex'}]})}}]})};
  };
  const payload=prepareColumnAnalysis({grid:[['姓名','学号','性别'],['测试甲','00123','']],identity:{rowIndex:1,nameCol:0,studentCol:1},headerRow:0,fields:p});
  const apiKey='sk-test-UNIQUE-123';
  const result=await analyzeColumns({payload,config:{},apiKey,fetchImpl:fakeFetch});
  assert.deepEqual(result.mappings,[{column:3,field:'sex'}]);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+apiKey);
  const body=JSON.parse(calls[0].options.body);
  assert.equal(body.messages[1].content.includes('00123'),true);
  assert.equal(body.messages[1].content.includes('测试甲'),true);
  assert.equal(body.messages[1].content.includes('13800000000'),false);
  assert.equal(calls[0].options.body.includes(apiKey),false);
});
