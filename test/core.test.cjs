const {test}=require('node:test');
const assert=require('node:assert/strict');
const {canonicalUrl,extractLinks,sourceMatches,buildPlan,openStore}=require('../src/core.cjs');
const p={name:'测试甲',student_id:'00123',sex:'男',age:19};
test('links: reject foreign host, retain sheet tab, parse JSON card',()=>{
  assert.throws(()=>canonicalUrl('https://docs.qq.com.evil/sheet/abc'));
  assert.equal(canonicalUrl('https://docs.qq.com/sheet/abc?scode=x&tab=T'),'https://docs.qq.com/sheet/abc?tab=T');
  assert.deepEqual(extractLinks({message:[{type:'json',data:{data:JSON.stringify({url:'https://docs.qq.com/sheet/abc?tab=T&scode=x'})}}]}),['https://docs.qq.com/sheet/abc?tab=T']);
});
test('source: nickname cannot replace stable ID and private/group stay distinct',()=>{
  assert.equal(sourceMatches({post_type:'message',message_type:'private',user_id:10},{type:'private',id:'10'}),true);
  assert.equal(sourceMatches({post_type:'message',message_type:'group',user_id:10,group_id:11},{type:'private',id:'10'}),false);
  assert.equal(sourceMatches({post_type:'message',message_type:'private',user_id:10},{type:'private',id:''}),false);
  assert.equal(sourceMatches({post_type:'message',message_type:'private',user_id:10,self_id:1},{type:'private',id:'10',account_id:'2'}),false);
  assert.equal(sourceMatches({post_type:'message',message_type:'private',user_id:10,self_id:2},{type:'private',id:'10',account_id:'2'}),true);
});
test('identity: skip same name, preserve leading zero and relocate inserted row',()=>{
  const rows=[['说明'],['姓名','学号','性别','年龄'],['测试甲','00124','',''],['测试甲','00123','','']];
  const plan=buildPlan(rows,p);assert.equal(plan.identityRow,4);assert.equal(plan.changes.length,2);
  assert.throws(()=>buildPlan([...rows,rows[3]],p),/identity_not_unique/);
  rows[3][2]='女';assert.throws(()=>buildPlan(rows,p),/existing_value_conflict/);
});
test('database: duplicates and interrupted writes cannot silently requeue',()=>{
  const s=openStore(':memory:');s.saveProfile(p);assert.equal(s.profile().student_id,'00123');
  assert.equal(s.enqueue('source:1','https://docs.qq.com/sheet/abc'),true);
  assert.equal(s.enqueue('source:1','https://docs.qq.com/sheet/abc'),false);
  s.update(1,'writing',{changes:[]});s.recover();assert.equal(s.summary()[0].state,'outcome_unknown');s.db.close();
});
test('database: source deduplication and write recovery survive closing the database',()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lab-poc-'));
  const file=path.join(dir,'state.sqlite');
  try {
    const first=openStore(file);first.saveProfile(p);
    first.enqueue('source:restart','https://docs.qq.com/sheet/test');
    first.update(1,'writing',{changes:[]});first.db.close();
    const second=openStore(file);
    assert.equal(second.profile().student_id,'00123');
    assert.equal(second.enqueue('source:restart','https://docs.qq.com/sheet/test'),false);
    second.recover();assert.equal(second.summary()[0].state,'outcome_unknown');second.db.close();
  } finally {
    const resolved=path.resolve(dir),tempRoot=path.resolve(os.tmpdir())+path.sep;
    if(!resolved.startsWith(tempRoot)||!path.basename(resolved).startsWith('lab-poc-'))throw Error('unexpected_test_directory');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
