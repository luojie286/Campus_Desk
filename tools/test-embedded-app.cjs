// 正式 App 的 USB 辅助验收：USB 仅传临时邀请和测试指令，业务请求走 tsnet。
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {createDeviceRepository}=require('../src/network/devices.cjs');
const root=path.resolve(__dirname,'..');
const adb=path.join(process.env.ANDROID_HOME||'E:/codex/l10reboot/.local/android-sdk','platform-tools','adb.exe');
function call(args,input,timeout=90000){
  const result=spawnSync(adb,args,{encoding:'utf8',input,timeout,windowsHide:true,maxBuffer:3*1024*1024});
  if(result.error||result.status!==0)throw Error('embedded_device_command_failed');
  return result.stdout||'';
}
async function main(){
  process.chdir(root);
  const rows=call(['devices']).split(/\r?\n/).map(x=>x.trim().split(/\s+/)).filter(x=>x[1]==='device');
  if(rows.length!==1)throw Error('exactly_one_device_required');
  const prefix=['-s',rows[0][0]],action=process.argv[2]||'status';
  if(action==='prepare'){
    const config=JSON.parse(fs.readFileSync('.private/config.json','utf8'));
    const base=JSON.parse(fs.readFileSync('.private/network.json','utf8')).base;
    const db=new DatabaseSync('.private/poc.sqlite');
    const devices=createDeviceRepository(db);
    try{
      const invite=devices.invite(String(config.account_id));
      call([...prefix,'shell',"run-as com.campusdesk.mobile sh -c 'umask 077; cat > files/embedded-test-invitation.json'"],JSON.stringify({version:1,base,...invite}));
      console.log(JSON.stringify({invitationPrepared:true,expiresAt:invite.expires_at}));
    }finally{db.close();}
    return;
  }
  if(['pairAndRead','readAfterProcessRestart'].includes(action)){
    if(action==='readAfterProcessRestart'){
      call([...prefix,'shell','am','start','-n','com.campusdesk.mobile/.MainActivity']);
      const pid=call([...prefix,'shell','pidof','com.campusdesk.mobile']).trim();
      if(!/^\d+$/.test(pid))throw Error('app_process_required');
      call([...prefix,'shell',"run-as com.campusdesk.mobile sh -c 'cat > files/embedded-restart-marker.txt'"],pid);
    }
    const result=call([...prefix,'shell','am','instrument','-w','-r','-e','class',
      'com.campusdesk.mobile.EmbeddedConnectionTest#'+action,'com.campusdesk.mobile.test/androidx.test.runner.AndroidJUnitRunner']);
    fs.writeFileSync('.private/embedded-'+action+'.txt',result);
    const passed=/OK \(1 test\)/.test(result)&&!/FAILURES|INSTRUMENTATION_FAILED|shortMsg=/.test(result);
    console.log(JSON.stringify({method:action,passed}));if(!passed)process.exitCode=1;
    return;
  }
  if(action==='status'){
    const evidence=JSON.parse(call([...prefix,'shell','run-as','com.campusdesk.mobile','cat','files/embedded-acceptance.json']));
    delete evidence.pid;
    fs.writeFileSync('.private/embedded-app-acceptance.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));return;
  }
  throw Error('use_prepare_pairAndRead_readAfterProcessRestart_status');
}
main().catch(()=>{console.error('embedded_app_test_failed');process.exitCode=1;});
