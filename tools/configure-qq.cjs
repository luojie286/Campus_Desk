// 登录后配置本地 OneBot 接入；只操作本项目私有目录。
const fs=require('node:fs');
const root='.private/vendor/napcat-4.18.41/config';
const app=JSON.parse(fs.readFileSync('.private/config.json'));
// 统一调用本机 OneBot API，并只接受 status=ok 的响应。
async function onebot(action, body) {
  const response = await fetch('http://127.0.0.1:9088/' + action, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const result = await response.json();
  if (!response.ok || result.status !== 'ok') throw Error('qq_api_failed_' + action);
  return result.data;
}
async function main(){
  // 群聊来源：按群名和成员昵称/群名片唯一定位，不把昵称当作运行时过滤依据。
  if(process.argv[2]==='resolve-group'){
    const groupName=process.argv[3];
    const senderName=process.argv[4];
    if(!groupName||!senderName)throw Error('group_and_sender_name_required');
    const self=await onebot('get_login_info',{});
    const account=String(self.user_id);
    if(app.account_id&&app.account_id!==account)throw Error('unexpected_qq_account');
    const groups=await onebot('get_group_list',{});
    const groupMatches=groups.filter(group=>group.group_name===groupName||group.groupName===groupName);
    if(groupMatches.length!==1)throw Error('group_match_count_'+groupMatches.length);
    const group=groupMatches[0];
    const members=await onebot('get_group_member_list',{group_id:Number(group.group_id)});
    const senderMatches=members.filter(member=>member.nickname===senderName||member.card===senderName);
    if(senderMatches.length!==1)throw Error('sender_match_count_'+senderMatches.length);
    const senderId=String(senderMatches[0].user_id);
    // 自己发送的消息默认不上报；绑定自号会导致永远收不到回调。
    if(senderId===account)throw Error('sender_is_self');
    app.account_id=account;
    app.source_name=senderName;
    app.source={type:'group',id:String(group.group_id),sender_id:senderId,account_id:account};
    fs.writeFileSync('.private/config.json',JSON.stringify(app,null,2));
    console.log('Group source resolved to one stable group and sender ID; saved privately.');
    return;
  }
  if(process.argv[2]==='resolve'){
    const selfResult=await (await fetch('http://127.0.0.1:9088/get_login_info',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)})).json();
    if(selfResult.status!=='ok')throw Error('qq_account_not_ready');
    const account=String(selfResult.data.user_id);
    if(app.account_id&&app.account_id!==account)throw Error('unexpected_qq_account');
    const response=await fetch('http://127.0.0.1:9088/get_friend_list',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error('QQ API unavailable: '+response.status);
    const result=await response.json();if(result.status!=='ok'||!Array.isArray(result.data))throw Error('friend_list_unavailable');
    const sourceName=process.argv[3]||app.source_name||'example-contact';
    const matches=result.data.filter(f=>f.nickname===sourceName||f.remark===sourceName);
    if(matches.length!==1)throw Error('friend_match_count_'+matches.length);
    app.account_id=account;
    app.source_name=sourceName;
    app.source={type:'private',id:String(matches[0].user_id),account_id:account};
    fs.writeFileSync('.private/config.json',JSON.stringify(app,null,2));
    console.log('Source resolved to one stable friend ID and bound to the logged-in account; saved privately.');
    return;
  }
  // 使用本项目新安装实例的管理令牌，通过正常 API 热加载，不退出已登录账号。
  const web=JSON.parse(fs.readFileSync(root+'/webui.json','utf8').replace(/^\uFEFF/,''));
  const hash=require('node:crypto').createHash('sha256').update(web.token+'.napcat').digest('hex');
  const login=await (await fetch('http://127.0.0.1:6099/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hash}),signal:AbortSignal.timeout(10000)})).json();
  if(!login.data?.Credential)throw Error('local_management_login_failed');
  const active=await (await fetch('http://127.0.0.1:6099/api/QQLogin/GetQQLoginInfo',{method:'POST',headers:{Authorization:'Bearer '+login.data.Credential},signal:AbortSignal.timeout(10000)})).json();
  const account=String(active.data?.uin||'');
  if(!/^\d+$/.test(account))throw Error('logged_in_account_not_ready');
  if(app.account_id&&app.account_id!==account)throw Error('unexpected_qq_account');
  const file=root+'/onebot11_'+account+'.json';
  if(!fs.existsSync(file))throw Error('active_account_config_missing');
  const settings=JSON.parse(fs.readFileSync(file));
  settings.network??={};
  settings.network.httpServers=[{name:'lab-local-api',enable:true,host:'127.0.0.1',port:9088,enableCors:false,enableWebsocket:false,messagePostFormat:'array',token:app.token,debug:false}];
  settings.network.httpClients=[{name:'lab-poc-events',enable:true,url:'http://127.0.0.1:9087/onebot',messagePostFormat:'array',reportSelfMessage:false,token:app.token,debug:false}];
  const applied=await (await fetch('http://127.0.0.1:6099/api/OB11Config/SetConfig',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.data.Credential},body:JSON.stringify({config:JSON.stringify(settings)}),signal:AbortSignal.timeout(10000)})).json();
  if(applied.code!==0)throw Error('local_config_reload_failed');
  app.account_id=account;
  fs.writeFileSync('.private/config.json',JSON.stringify(app,null,2));
  console.log('Local OneBot API and event callback configured and hot-reloaded.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
