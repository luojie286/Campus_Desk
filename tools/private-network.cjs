// 所有凭证只进 .private/；命令行与普通输出不携带邀请、令牌、QQ 账号或私网主机名。
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {loadConfig}=require('../src/config.cjs');
const {applyMigrations,CURRENT_VERSION}=require('../src/db/migrate.cjs');
const {backupDatabase}=require('../src/db/backup.cjs');
const {createDeviceRepository}=require('../src/network/devices.cjs');
const {createGateway}=require('../src/network/gateway.cjs');
const {accountHasHistory}=require('../src/workspace/context.cjs');

const root=path.resolve(__dirname,'..'),privateDir=path.join(root,'.private');
const configFile=path.join(privateDir,'config.json'),dbFile=path.join(privateDir,'poc.sqlite');
const networkFile=path.join(privateDir,'network.json');
const tsExe=process.platform==='win32'?'C:/Program Files/Tailscale/tailscale.exe':'tailscale';
const config=()=>loadConfig(configFile,{allowUnconfigured:true});
function ts(args){return spawnSync(tsExe,args,{encoding:'utf8',timeout:12_000,windowsHide:true});}
function tsJson(args){const result=ts(args);if(result.status!==0)throw Error('tailscale_not_ready');return JSON.parse(result.stdout);}
function hasServe(value){return Object.keys(value?.TCP||{}).length>0||Object.keys(value?.Web||{}).length>0;}
function hasFunnel(value){return Object.values(value?.AllowFunnel||{}).some(Boolean);}
function networkBase(){
  const value=JSON.parse(fs.readFileSync(networkFile,'utf8')).base;
  const url=new URL(value);
  if(url.protocol!=='https:'||!url.hostname.endsWith('.ts.net')||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('network_base_invalid');
  return url.origin;
}
function openDevices(){
  const db=new DatabaseSync(dbFile);db.exec('PRAGMA busy_timeout=5000');
  const version=db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
  if(version<CURRENT_VERSION){
    backupDatabase(dbFile,path.join(privateDir,'backups',`before-network-${Date.now()}.sqlite`));
    applyMigrations(db);
  }
  return {db,devices:createDeviceRepository(db)};
}
async function main(){
  process.chdir(root);
  const [command='status',argument]=process.argv.slice(2);
  if(command==='tailscale-setup'){
    const status=tsJson(['status','--json']),before=tsJson(['serve','status','--json']);
    if(status.BackendState!=='Running'||!status.Self?.Online||!status.Self?.DNSName)throw Error('tailscale_not_online');
    if(hasServe(before)||hasFunnel(before))throw Error('existing_serve_config_preserved');
    // 不执行 Funnel，也不重置或覆盖其他项目配置。未满足 HTTPS 前提时保留私人诊断供本人查看。
    const result=ts(['serve','--bg','--https=443','http://127.0.0.1:9090']);
    fs.writeFileSync(path.join(privateDir,'tailscale-serve-setup.txt'),(result.stdout||'')+(result.stderr||''),{mode:0o600});
    const after=tsJson(['serve','status','--json']);
    const web=Object.values(after.Web||{});
    if(!after.TCP?.['443']?.HTTPS||web.length!==1||web[0]?.Handlers?.['/']?.Proxy!=='http://127.0.0.1:9090'||hasFunnel(after))throw Error('tailscale_https_setup_pending');
    fs.writeFileSync(networkFile,JSON.stringify({base:'https://'+status.Self.DNSName.replace(/\.$/,''),port:9090},null,2),{mode:0o600});
    console.log(JSON.stringify({serveConfigured:true,funnel:false,endpointSaved:'.private/network.json'}));return;
  }
  if(command==='probe'){
    const response=await fetch(networkBase()+'/health',{redirect:'manual',signal:AbortSignal.timeout(12_000)});
    const body=await response.json();console.log(JSON.stringify({httpsStatus:response.status,gateway:body.service==='mobile-gateway',running:body.running===true}));return;
  }
  if(!fs.existsSync(dbFile))throw Error('database_not_initialized');
  const {db,devices}=openDevices();
  if(command==='serve'){
    const server=createGateway({devices,getConfig:config,authorizeAccount:account=>accountHasHistory(db,account)});
    server.on('error',()=>{console.error('mobile_gateway_listen_failed');db.close();process.exitCode=1;});
    server.listen(9090,'127.0.0.1',()=>console.log('Mobile gateway listening on 127.0.0.1:9090'));
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
    return;
  }
  try{
    const account=String(config().account_id||'');
    if(!account)throw Error('account_not_configured');
    if(command==='invite'){
      if(!accountHasHistory(db,account))throw Error('workspace_source_unavailable');
      const base=networkBase();
      const invite=devices.invite(account,{readOnly:argument==='--read-only'});
      const file=path.join(privateDir,'pairing-invitation.json');
      fs.writeFileSync(file,JSON.stringify({version:1,base,...invite},null,2),{mode:0o600});
      console.log(JSON.stringify({invitationFile:'.private/pairing-invitation.json',expires_at:invite.expires_at}));
    }else if(command==='devices')console.log(JSON.stringify(devices.list(account),null,2));
    else if(command==='revoke'){
      if(!argument)throw Error('device_id_required');
      console.log(JSON.stringify({revoked:devices.revoke(argument,account)}));
    }else if(command==='status'){
      let state='unavailable',online=false,serve=false,funnel=false;
      try{const s=tsJson(['status','--json']);state=s.BackendState;online=!!s.Self?.Online;const v=tsJson(['serve','status','--json']);serve=hasServe(v);funnel=hasFunnel(v);}catch{}
      const list=devices.list(account);
      console.log(JSON.stringify({schemaVersion:db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
        tailscale:{state,online,serve,funnel},endpointConfigured:fs.existsSync(networkFile),devices:list.length,
        activeDevices:list.filter(d=>!d.revoked_at&&d.expires_at>new Date().toISOString()).length}));
    }else throw Error('use_status_serve_invite_devices_revoke_tailscale-setup_or_probe');
  }finally{db.close();}
}
if(require.main===module)main().catch(error=>{
  // 不回显库路径、远端 URL、请求正文或系统异常原文。
  const allowed=/^(tailscale_|existing_|network_|account_|database_|device_|use_)/.test(error.message);
  console.error(allowed?error.message:'private_network_command_failed');process.exitCode=1;
});
