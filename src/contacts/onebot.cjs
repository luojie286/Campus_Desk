// 通过本机 OneBot HTTP API 读取群/好友备注，仅用于展示名称；运行时过滤仍使用稳定 ID。
const DEFAULT_BASE='http://127.0.0.1:9088';

async function call(action,body,{config={},fetchImpl=fetch}={}){
  const base=String(config.onebot?.api_base||DEFAULT_BASE).replace(/\/+$/,'');
  const token=config.onebot?.token||config.token;
  if(!token)throw Error('onebot_token_missing');
  let response;
  try{
    response=await fetchImpl(base+'/'+action,{
      method:'POST',
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(body||{}),
      signal:AbortSignal.timeout(15000)
    });
  }catch{
    throw Error('onebot_unreachable');
  }
  if(!response.ok)throw Error('onebot_http_'+response.status);
  let json;
  try{json=await response.json();}catch{throw Error('onebot_invalid_json');}
  if(json?.status!=='ok')throw Error('onebot_action_failed');
  return json.data;
}

async function getGroups(options){
  const data=await call('get_group_list',{},options);
  return (Array.isArray(data)?data:[]).map(group=>({
    id:String(group.group_id),
    name:group.group_name||String(group.group_id)
  }));
}

async function getGroupMembers(groupId,options){
  const data=await call('get_group_member_list',{group_id:Number(groupId)},options);
  return (Array.isArray(data)?data:[]).map(member=>({
    id:String(member.user_id),
    name:member.card||member.nickname||String(member.user_id),
    nickname:member.nickname||null,
    card:member.card||null
  }));
}

async function getFriends(options){
  const data=await call('get_friend_list',{},options);
  return (Array.isArray(data)?data:[]).map(friend=>({
    id:String(friend.user_id),
    name:friend.remark||friend.nickname||String(friend.user_id),
    nickname:friend.nickname||null,
    remark:friend.remark||null
  }));
}

module.exports={call,getGroups,getGroupMembers,getFriends};
