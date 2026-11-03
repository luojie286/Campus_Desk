// 在真实本机后台做只读联调。临时设备凭证仅在内存中，结束后撤销。
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const {createDeviceRepository}=require('../src/network/devices.cjs');
const {loadConfig}=require('../src/config.cjs');
async function main(){
  const config=loadConfig('.private/config.json',{allowUnconfigured:true});
  const db=new DatabaseSync('.private/poc.sqlite');db.exec('PRAGMA busy_timeout=5000');
  const devices=createDeviceRepository(db),account=String(config.account_id);
  const invitation=devices.invite(account,{readOnly:true});
  let paired;
  const result={transport:'local-loopback',pairing:false,reads:{},writeDenied:false,revocation:false,backendAccountGuard:false};
  try{
    const response=await fetch('http://127.0.0.1:9090/v1/device-pairings',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({code:invitation.code,name:'local-private-network-smoke'}),signal:AbortSignal.timeout(10_000)});
    if(response.status!==201)throw Error('smoke_pairing_failed');
    paired=await response.json();result.pairing=true;
    const headers={Authorization:'Bearer '+paired.token};
    for(const path of ['tasks','suggestions?status=pending','todos','briefings','briefing-settings']){
      const read=await fetch('http://127.0.0.1:9090/v1/'+path,{headers,signal:AbortSignal.timeout(10_000)});
      // 真实内容不落日志；只记录接口状态码，且必须全部认证成功。
      result.reads[path]=read.status;await read.body.cancel();
      if(read.status!==200)throw Error('smoke_read_failed');
    }
    const denied=await fetch('http://127.0.0.1:9090/v1/tasks/1/cancel',{method:'POST',headers,body:'{}'});
    result.writeDenied=denied.status===403;await denied.body.cancel();
    // 使用错误的网关账号头验证后台已加载最新账号保护；仅 GET，不修改任务。
    const guard=await fetch(`http://127.0.0.1:${config.port}/v1/tasks`,{headers:{Authorization:'Bearer '+config.token,'X-Campus-Account':'invalid-smoke-account'}});
    result.backendAccountGuard=guard.status===409;await guard.body.cancel();
    devices.revoke(paired.device_id,account);
    const revoked=await fetch('http://127.0.0.1:9090/v1/tasks',{headers});result.revocation=revoked.status===401;await revoked.body.cancel();
    if(!result.writeDenied||!result.revocation||!result.backendAccountGuard)throw Error('smoke_guard_failed');
  }finally{
    if(paired)devices.revoke(paired.device_id,account);db.close();
    fs.writeFileSync('.private/private-network-smoke.json',JSON.stringify(result,null,2),{mode:0o600});
    console.log(JSON.stringify(result));
  }
}
main().catch(()=>{console.error('private_network_smoke_failed');process.exitCode=1;});
