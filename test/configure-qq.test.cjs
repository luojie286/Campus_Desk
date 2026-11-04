const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('QQ setup: a missing contact name fails before contacting OneBot',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lab-qq-setup-'));
  try{
    const privateDir=path.join(dir,'.private');
    fs.mkdirSync(privateDir);
    const configFile=path.join(privateDir,'config.json');
    const config=JSON.stringify({token:'synthetic-setup-test-token',source_name:''});
    fs.writeFileSync(configFile,config);
    const result=spawnSync(process.execPath,[path.resolve(__dirname,'../tools/configure-qq.cjs'),'resolve'],{
      cwd:dir,encoding:'utf8',timeout:5000,windowsHide:true
    });
    assert.equal(result.error,undefined);
    assert.equal(result.status,1);
    assert.equal(result.stderr.trim(),'source_name_required');
    assert.equal(result.stdout,'');
    assert.equal(fs.readFileSync(configFile,'utf8'),config);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
