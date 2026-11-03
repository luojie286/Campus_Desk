// 本工具只准备只读设备凭证、读取脱敏结果、撤销测试设备，不发送业务修改请求。
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {createDeviceRepository}=require('../src/network/devices.cjs');
const root=path.resolve(__dirname,'..');
const adb=path.join(process.env.ANDROID_HOME||'E:/codex/l10reboot/.local/android-sdk','platform-tools','adb.exe');
const packageName='com.campusdesk.tsnetprobe';
function call(args,input){
  const result=spawnSync(adb,args,{encoding:'utf8',input,timeout:15_000,windowsHide:true});
  if(result.error||result.status!==0)throw Error('probe_adb_failed');
  return result.stdout||'';
}
function prefix(){
  const rows=call(['devices']).split(/\r?\n/).map(x=>x.trim().split(/\s+/)).filter(x=>x[1]==='device');
  if(rows.length!==1)throw Error('exactly_one_device_required');
  return ['-s',rows[0][0],'shell'];
}
async function main(){
  process.chdir(root);
  const action=process.argv[2]||'status',p=prefix();
  if(action==='status'){
    const raw=JSON.parse(call([...p,'run-as',packageName,'cat','files/probe-evidence.json']));
    const safe={androidApi:raw.androidApi,usesVpnService:raw.usesVpnService,
      vpnBefore:raw.vpnBefore?.length>0,vpnAfter:raw.vpnAfter?.length>0,sameVpn:raw.sameVpn,
      stage:raw.stage||'not_started',httpStatus:raw.httpStatus,validJson:raw.validJson,readAttempts:raw.readAttempts};
    fs.writeFileSync('.private/tsnet-device-summary.json',JSON.stringify(safe,null,2));
    console.log(JSON.stringify(safe));return;
  }
  if(!['prepare','cleanup'].includes(action))throw Error('use_prepare_status_cleanup');
  const config=JSON.parse(fs.readFileSync('.private/config.json','utf8'));
  const db=new DatabaseSync('.private/poc.sqlite');db.exec('PRAGMA busy_timeout=5000');
  const devices=createDeviceRepository(db),account=String(config.account_id);
  const credentialFile='.private/tsnet-probe-device.json';
  try{
    if(fs.existsSync(credentialFile)){
      const previous=JSON.parse(fs.readFileSync(credentialFile,'utf8'));
      devices.revoke(previous.id,previous.account);
      fs.unlinkSync(credentialFile);
    }
    if(action==='cleanup'){
      call([...p,'run-as',packageName,'rm','-f','files/probe-config.json']);
      console.log(JSON.stringify({credentialRemoved:true,testDeviceRevoked:true}));return;
    }
    const base=JSON.parse(fs.readFileSync('.private/network.json','utf8')).base;
    const invitation=devices.invite(account,{readOnly:true});
    const response=await fetch('http://127.0.0.1:9090/v1/device-pairings',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({code:invitation.code,name:'android-tsnet-readonly-probe'}),
      signal:AbortSignal.timeout(10_000)});
    if(response.status!==201)throw Error('probe_pairing_failed');
    const paired=await response.json();
    fs.writeFileSync(credentialFile,JSON.stringify({id:paired.device_id,account}),{mode:0o600});
    // 私密 JSON 仅经 stdin 写入 App 私有目录，不放 adb 参数或测试报告。
    call([...p,`run-as ${packageName} sh -c 'umask 077; cat > files/probe-config.json'`],JSON.stringify({base,token:paired.token}));
    console.log(JSON.stringify({prepared:true,permission:'read-only',tokenInLogs:false}));
  }finally{db.close();}
}
main().catch(()=>{console.error('tsnet_probe_command_failed');process.exitCode=1;});
