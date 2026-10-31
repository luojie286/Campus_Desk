const {test}=require('node:test');
const assert=require('node:assert/strict');
const {getGroups,getGroupMembers,getFriends}=require('../src/contacts/onebot.cjs');

const config={token:'test-token'};
test('contacts: map group names and member cards from OneBot',async()=>{
  const groups=await getGroups({config,fetchImpl:async()=>({ok:true,status:200,json:async()=>({status:'ok',data:[{group_id:6318,group_name:'实验室群'}]})})});
  assert.deepEqual(groups,[{id:'6318',name:'实验室群'}]);
  const members=await getGroupMembers('6318',{config,fetchImpl:async()=>({ok:true,status:200,json:async()=>({status:'ok',data:[{user_id:1278,nickname:'昵称',card:'班级备注'}]})})});
  assert.equal(members[0].name,'班级备注');
  const friends=await getFriends({config,fetchImpl:async()=>({ok:true,status:200,json:async()=>({status:'ok',data:[{user_id:2001,nickname:'昵称',remark:'好友备注'}]})})});
  assert.equal(friends[0].name,'好友备注');
});
test('contacts: unreachable OneBot is reported as a stable error',async()=>{
  await assert.rejects(
    ()=>getGroups({config,fetchImpl:async()=>{throw Error('fetch failed');}}),
    /onebot_unreachable/
  );
});
