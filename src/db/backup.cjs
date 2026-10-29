// 使用 SQLite 的 VACUUM INTO 做一致性副本，再校验副本并写清单。
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');

function backupDatabase(sourceFile,targetFile){
  const source=path.resolve(sourceFile);
  const target=path.resolve(targetFile);
  if(!fs.existsSync(source))throw Error('backup_source_missing');
  if(fs.existsSync(target))throw Error('backup_target_exists');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const db=new DatabaseSync(source);
  try{
    // VACUUM INTO 生成一致快照，不修改源数据库；路径中的单引号需转义。
    db.exec("VACUUM INTO '"+target.replace(/'/g,"''")+"'");
  }finally{
    db.close();
  }
  const check=new DatabaseSync(target);
  let integrity=null;
  try{
    const row=check.prepare('PRAGMA integrity_check').get();
    integrity=row?Object.values(row)[0]:null;
  }finally{
    check.close();
  }
  if(integrity!=='ok')throw Error('backup_integrity_failed');
  const bytes=fs.readFileSync(target);
  const manifest={
    created_at:new Date().toISOString(),
    source:path.basename(source),
    target:path.basename(target),
    size:bytes.length,
    sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
    integrity
  };
  fs.writeFileSync(target+'.json',JSON.stringify(manifest,null,2));
  return manifest;
}

module.exports={backupDatabase};
