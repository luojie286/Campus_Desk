// 此工具只准备账号配置；进程切换由 switch-account.ps1 管理。
const fs=require('node:fs');
const crypto=require('node:crypto');
const file='.private/config.json';
const config=JSON.parse(fs.readFileSync(file,'utf8'));
const mode=process.argv[2];
if(!['switch-qq','relogin-qq','relogin-document'].includes(mode))throw Error('Unknown account operation');
fs.mkdirSync('.private/account-backups',{recursive:true});
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
fs.copyFileSync(file,'.private/account-backups/config-'+stamp+'.json');
config.execute=false;
if(mode==='switch-qq'){
  config.account_id='';
  config.source={type:'private',id:''};
}
if(mode==='switch-qq'||mode==='relogin-document'){
  config.browser_profile='.private/document-sessions/'+crypto.randomUUID();
}
fs.writeFileSync(file,JSON.stringify(config,null,2));
console.log(JSON.stringify({mode,execute:false,sourceConfigured:!!config.source.id,newDocumentSession:mode!=='relogin-qq',previousConfigurationSaved:true}));
