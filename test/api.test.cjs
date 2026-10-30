const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createMessageRepository}=require('../src/db/repositories/messages.cjs');
const {createSuggestionRepository}=require('../src/db/repositories/suggestions.cjs');
const {createV2Handler}=require('../src/api/v2.cjs');

const now='2026-10-30T06:00:00.000Z';
const baseMessage={
  platform:'qq',adapterInstance:'onebot-main',accountRef:'7007',conversationType:'group',
  conversationId:'6318',senderId:'1278',sourceTime:now,receivedAt:now,kind:'text',
  contentJson:null,completeness:'full',identityQuality:'stable_id',rawJson:'{}'
};
test('api: auth, message center, suggestions and todos',async()=>{
  const store=openStore(':memory:');
  applyMigrations(store.db);
  const messages=createMessageRepository(store.db);
  const suggestions=createSuggestionRepository(store.db);
  const config={token:'test-token-123',account_id:'7007'};
  const message=messages.insert({...baseMessage,sourceMessageId:'m1',contentText:'请填写报名表',linkJson:'["https://docs.qq.com/sheet/abc"]'});
  const other=messages.insert({...baseMessage,sourceMessageId:'m2',contentText:'普通聊天',linkJson:'[]'});
  const acceptId=suggestions.insert({messageId:message.id,messageVersion:1,kind:'todo',title:'填写报名表',summary:'群内发布报名表',category:'form',confidence:0.9,actionJson:{links:['https://docs.qq.com/sheet/abc']},status:'pending',rationale:'含链接',model:'deepseek-chat',createdAt:now});
  const dismissId=suggestions.insert({messageId:other.id,messageVersion:1,kind:'todo',title:'普通聊天',summary:'无行动',category:'chat',confidence:0.2,actionJson:{},status:'pending',rationale:'无行动',model:'deepseek-chat',createdAt:now});
  const handler=createV2Handler({messages,suggestions,config});
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const handled=await handler(req,res,url.pathname,url.searchParams);
    if(!handled){
      res.statusCode=404;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({error:'not_found'}));
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const auth={Authorization:'Bearer '+config.token,'Content-Type':'application/json'};
  const call=async(path,options={})=>{
    const response=await fetch(origin+path,options);
    return {status:response.status,body:await response.json().catch(()=>null)};
  };
  try{
    const unauth=await call('/v1/messages');
    assert.equal(unauth.status,401);
    const list=await call('/v1/messages',{headers:auth});
    assert.equal(list.status,200);
    assert.equal(list.body.items.length,2);
    const first=list.body.items.find(item=>item.id===message.id);
    assert.equal(first.text,'请填写报名表');
    assert.deepEqual(first.links,['https://docs.qq.com/sheet/abc']);
    const detail=await call('/v1/messages/'+message.id,{headers:auth});
    assert.equal(detail.status,200);
    assert.equal(detail.body.suggestions.length,1);
    const read=await call('/v1/messages/'+message.id,{method:'PATCH',headers:auth,body:JSON.stringify({read:true})});
    assert.equal(read.status,200);
    const unread=await call('/v1/messages?unread=1',{headers:auth});
    assert.equal(unread.body.items.length,1);
    const pending=await call('/v1/suggestions?status=pending',{headers:auth});
    assert.equal(pending.body.items.length,2);
    const accept=await call('/v1/suggestions/'+acceptId+'/accept',{method:'POST',headers:auth,body:'{}'});
    assert.equal(accept.status,200);
    assert.equal(accept.body.todo.title,'填写报名表');
    assert.deepEqual(accept.body.tasks,[]);
    const duplicate=await call('/v1/suggestions/'+acceptId+'/accept',{method:'POST',headers:auth,body:'{}'});
    assert.equal(duplicate.status,409);
    const todos=await call('/v1/todos',{headers:auth});
    assert.equal(todos.body.items.length,1);
    const dismiss=await call('/v1/suggestions/'+dismissId+'/dismiss',{method:'POST',headers:auth,body:'{}'});
    assert.equal(dismiss.status,200);
    const after=await call('/v1/suggestions?status=pending',{headers:auth});
    assert.equal(after.body.items.length,0);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    store.db.close();
  }
});
