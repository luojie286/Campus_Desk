const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');

function claimLegacy({allowPythonOwner=false}={}){
  // Hold a write reservation on a dedicated database, never on business data.
  // SQLite releases it automatically even when a Windows process is terminated.
  const lock=new DatabaseSync('.private/legacy-business.sqlite');
  try{
    lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  }catch(error){
    lock.close();
    if(error.code==='ERR_SQLITE_ERROR'&&error.errcode===5)throw Error('legacy_business_locked');
    throw error;
  }
  process.once('exit',()=>lock.close());
  if(!allowPythonOwner&&fs.existsSync('.private/python-business.owner'))throw Error('python_business_owner');
}
module.exports={claimLegacy};
