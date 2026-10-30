const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {validateConfig,loadConfig}=require('../src/config.cjs');

const base={
  port:9087,
  token:'a'.repeat(64),
  execute:false,
  account_id:'7007',
  source:{type:'group',id:'6318',sender_id:'1278',account_id:'7007'}
};

test('config: accepts a bound group source',()=>{
  assert.deepEqual(validateConfig(base),{ok:true,errors:[]});
});
test('config: rejects invalid port, source, token and account identifiers',()=>{
  const cases=[
    [{...base,port:0},'port_invalid'],
    [{...base,port:'9087'},'port_invalid'],
    [{...base,token:'short'},'token_invalid'],
    [{...base,execute:'false'},'execute_invalid'],
    [{...base,source:{type:'group',id:'6318'}},'source_sender_missing'],
    [{...base,source:{type:'private',id:''}},'source_id_missing'],
    [{...base,source:{type:'chat',id:'1'}},'source_type_invalid'],
    [{...base,account_id:'abc'},'account_id_invalid'],
    [{...base,messageCenter:'yes'},'messageCenter_invalid'],
    [{...base,pipeline:'v3'},'pipeline_invalid']
  ];
  for(const [config,code] of cases){
    const result=validateConfig(config);
    assert.equal(result.ok,false);
    assert.equal(result.errors.includes(code),true,`expected ${code}, got ${result.errors.join(',')}`);
  }
});
test('config: allowUnconfigured permits first-run setup with an empty source',()=>{
  const unconfigured={...base,account_id:'',source:{type:'private',id:''}};
  assert.equal(validateConfig(unconfigured).ok,false);
  assert.equal(validateConfig(unconfigured,{allowUnconfigured:true}).ok,true);
  assert.equal(validateConfig({...base,source:{type:'group',id:''}},{allowUnconfigured:true}).ok,true);
  assert.equal(validateConfig({...base,source:{type:'group',id:'6318'}},{allowUnconfigured:true}).ok,false);
});
test('config: load reports JSON and validation failures without echoing secrets',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lab-config-'));
  try{
    const badJson=path.join(dir,'bad.json');
    fs.writeFileSync(badJson,'{not json');
    assert.throws(()=>loadConfig(badJson),/config_json_invalid/);
    const invalid=path.join(dir,'invalid.json');
    fs.writeFileSync(invalid,JSON.stringify({...base,token:'secret-short'}));
    assert.throws(()=>loadConfig(invalid),error=>{
      assert.match(error.message,/invalid_config/);
      assert.equal(error.message.includes('secret-short'),false);
      return true;
    });
    const valid=path.join(dir,'valid.json');
    fs.writeFileSync(valid,JSON.stringify(base));
    assert.equal(loadConfig(valid).port,9087);
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
