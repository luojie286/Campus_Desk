const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openStore}=require('../src/core.cjs');
const {backupDatabase}=require('../src/db/backup.cjs');

test('backup: copies committed data, verifies integrity and refuses to overwrite',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lab-backup-'));
  try{
    const source=path.join(dir,'source.sqlite');
    const target=path.join(dir,'backups','copy.sqlite');
    const store=openStore(source);
    store.saveProfile({name:'测试甲',student_id:'00123',sex:'男',age:19});
    store.enqueue('source:1','https://docs.qq.com/sheet/abc');
    store.db.close();
    const manifest=backupDatabase(source,target);
    assert.equal(fs.existsSync(target),true);
    assert.equal(manifest.integrity,'ok');
    assert.equal(manifest.sha256.length,64);
    assert.equal(JSON.parse(fs.readFileSync(target+'.json','utf8')).integrity,'ok');
    const restored=openStore(target);
    assert.equal(restored.profile().student_id,'00123');
    assert.equal(restored.summary().length,1);
    restored.db.close();
    assert.throws(()=>backupDatabase(source,target),/backup_target_exists/);
  } finally {
    const resolved=path.resolve(dir),tempRoot=path.resolve(os.tmpdir())+path.sep;
    if(!resolved.startsWith(tempRoot)||!path.basename(resolved).startsWith('lab-backup-'))throw Error('unexpected_test_directory');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
