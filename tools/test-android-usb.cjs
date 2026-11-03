// 真机测试入口。令牌通过 stdin 写入 debug 应用私有目录，不放进 adb 参数、剪贴板或日志。
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const adb=path.join(process.env.ANDROID_HOME||'E:/codex/l10reboot/.local/android-sdk','platform-tools','adb.exe');
function call(args,input,timeout=90000){
  const r=spawnSync(adb,args,{cwd:root,input,encoding:'utf8',timeout,windowsHide:true,maxBuffer:4*1024*1024});
  if(r.error||r.status!==0)throw Error('adb_command_failed');
  return r.stdout||'';
}
function main(){
  const devices=call(['devices']).split(/\r?\n/).map(line=>line.trim().split(/\s+/)).filter(row=>row[1]==='device');
  if(devices.length!==1)throw Error('exactly_one_authorized_usb_device_required');
  const serial=devices[0][0],prefix=['-s',serial];
  const config=JSON.parse(fs.readFileSync(path.join(root,'.private/config.json'),'utf8'));
  if(config.port!==9087)throw Error('usb_test_expects_port_9087');
  call([...prefix,'reverse','tcp:9087','tcp:9087']);
  const apk=path.join(root,'mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
  call([...prefix,'install','--no-streaming','-r','-t',apk]);
  call([...prefix,'shell','run-as','com.campusdesk.mobile','mkdir','-p','files']);
  const payload=JSON.stringify({base:'http://127.0.0.1:9087',token:config.token});
  call([...prefix,'shell',"run-as com.campusdesk.mobile sh -c 'umask 077; cat > files/usb-test-config.json'"],payload);
  const cases=[];const output=[];
  try{
    for(const method of ['configureAndReadBackend','readSavedTokenInNewProcess','postSyntheticNotification','diagnoseSyncRoundTrip','readAgainAfterConnectionIdle']){
      const result=call([...prefix,'shell','am','instrument','-w','-r','-e','class',
        'com.campusdesk.mobile.UsbConnectionTest#'+method,'com.campusdesk.mobile.test/androidx.test.runner.AndroidJUnitRunner']);
      output.push(result);
      const passed=/OK \(1 test\)/.test(result)&&!/FAILURES|INSTRUMENTATION_FAILED|shortMsg=/.test(result);
      cases.push({method,passed});
      console.log(JSON.stringify({method,passed}));
      if(!passed)throw Error('device_test_failed_'+method);
    }
    const evidence=JSON.parse(call([...prefix,'shell','run-as','com.campusdesk.mobile','cat','files/usb-test-evidence.json']));
    delete evidence.processId;
    const report={checked_at:new Date().toISOString(),cases,evidence};
    fs.writeFileSync(path.join(root,'.private/usb-device-test-summary.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({deviceTestsPassed:true,evidence}));
  }finally{
    fs.writeFileSync(path.join(root,'.private/usb-instrumentation-output.txt'),output.join('\n'));
    // 只清理本工具传入的临时凭证；保留 Android Keystore 中加密后的正常连接设置。
    try{call([...prefix,'shell','run-as','com.campusdesk.mobile','rm','-f','files/usb-test-config.json']);}catch{}
  }
}
try{main();}catch(error){console.error(String(error.message||'usb_test_failed'));process.exitCode=1;}
