const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createMessageRepository}=require('../src/db/repositories/messages.cjs');
const {createBriefingRepository}=require('../src/briefings/repository.cjs');
const {localClock,validateSettings,buildPayload,validateBriefing,generateBriefing}=require('../src/briefings/core.cjs');
const {processBriefing:runBriefing}=require('../src/briefings/worker.cjs');
const {createV2Handler}=require('../src/api/v2.cjs');
const now='2026-11-03T23:00:00.000Z'; // Asia/Yakutsk 次日 08:00
const article={ref:'news:sample',title:'示例技术进展',source:'Example',category:'technology',url:'https://example.com/news',published_at:now};
const collect=async()=>({sources:[article],coverage:[{source:'Example',status:'ok',count:1}]});
const processBriefing=options=>runBriefing({collect,...options});
function setup(){const store=openStore(':memory:');applyMigrations(store.db);return {store,repo:createBriefingRepository(store.db)};}
function seed(db,accountRef='7007'){
  return createMessageRepository(db).insert({platform:'qq',adapterInstance:'test',accountRef,conversationType:'group',conversationId:'123456789',senderId:'987654321',sourceMessageId:'one',kind:'text',contentText:'请在周五报名，联系电话12345678901',receivedAt:now,rawJson:'{}'});
}
test('briefing: time-zone clock crosses local date correctly and settings reject invalid data',()=>{
  assert.deepEqual(localClock(now,'Asia/Yakutsk'),{date:'2026-11-04',time:'08:00'});
  for(const value of [{enabled:true,time:'25:00',time_zone:'UTC'},{enabled:true,time:'08:00',time_zone:'wrong'},{enabled:'yes',time:'08:00',time_zone:'UTC'}])assert.throws(()=>validateSettings(value));
});
test('briefing: disabled schedule does nothing, exact time and late startup claim today only',()=>{
  const {store,repo}=setup();assert.equal(repo.claim('7007',now),null);
  repo.saveSettings('7007',{enabled:true,time:'08:00',time_zone:'Asia/Yakutsk'});
  assert.equal(repo.claim('7007','2026-11-03T22:59:00.000Z'),null);
  const row=repo.claim('7007',now);assert.equal(row.local_date,'2026-11-04');assert.equal(repo.claim('7007',now),null);
  const later=repo.claim('7007','2026-11-05T03:00:00.000Z');assert.equal(later.local_date,'2026-11-05');
  assert.equal(repo.list('7007').length,2);store.db.close();
});
test('briefing: manual requests work with schedule off and dedupe per account date',()=>{
  const {store,repo}=setup();const first=repo.ensure('7007',now,true),second=repo.ensure('7007',now,true);
  assert.equal(first.id,second.id);assert.ok(repo.claim('7007',now));assert.equal(repo.list('other').length,0);assert.equal(repo.get('other',first.id),null);store.db.close();
});
test('briefing: public news payload never reads QQ messages or personal data',async()=>{
  const {store,repo}=setup();seed(store.db);seed(store.db,'other');
  const p=await buildPayload(store.db,'7007',now,repo.settings('7007'),{collect});
  assert.equal(p.sources.length,1);const text=JSON.stringify(p);
  for(const value of ['12345678901','123456789','987654321','account_ref'])assert.equal(text.includes(value),false);
  store.db.close();
});
test('briefing: model output must reference supplied sources',()=>{
  const p={sources:[{ref:'message:1'}]};
  assert.throws(()=>validateBriefing({intro:'ok',sections:[{title:'栏目',items:[{text:'内容',ref:'message:2'}]}]},p),/reference/);
  assert.throws(()=>validateBriefing({intro:'ok',sections:[]},p),/empty/);
  assert.equal(validateBriefing({intro:'ok',sections:[{title:'栏目',items:[{text:'内容',ref:'message:1'}]}]},p).sections.length,1);
});
test('briefing: worker saves one AI report and repeat ticks never generate it again',async()=>{
  const {store,repo}=setup();seed(store.db);repo.ensure('7007',now,true);let calls=0;
  const generate=async({payload})=>{calls++;return {intro:'早上好',sections:[{title:'校园通知',items:[{text:'请核对报名通知',ref:payload.sources[0].ref}]}]};};
  assert.equal((await processBriefing({db:store.db,briefings:repo,accountRef:'7007',now,generate})).mode,'ai');
  assert.equal((await processBriefing({db:store.db,briefings:repo,accountRef:'7007',now,generate})).processed,false);
  assert.equal(calls,1);assert.equal(repo.list('7007')[0].state,'ready');store.db.close();
});
test('briefing: no key produces explicitly marked rule report and never leaks raw exception',async()=>{
  const {store,repo}=setup();repo.ensure('7007',now,true);
  const r=await processBriefing({db:store.db,briefings:repo,accountRef:'7007',now,generate:async()=>{throw Error('briefing_key_missing');}});
  assert.equal(r.mode,'rules');assert.equal(repo.list('7007')[0].content.sections.length,1);store.db.close();
});
test('briefing: bounded retry falls back on third failure and stores only a stable error',async()=>{
  const {store,repo}=setup();repo.ensure('7007',now,true);
  const generate=async()=>{throw Error('SECRET transport body');};
  for(let i=0;i<3;i++)await processBriefing({db:store.db,briefings:repo,accountRef:'7007',now:new Date(Date.parse(now)+i*300000).toISOString(),generate});
  const row=repo.list('7007')[0];assert.equal(row.mode,'rules');assert.equal(row.error_class,'briefing_generation_failed');assert.equal(row.state,'ready');store.db.close();
});
test('briefing: expired leases can recover even after three interrupted attempts',async()=>{
  const {store,repo}=setup();repo.ensure('7007',now,true);
  let last;for(let i=0;i<3;i++)last=repo.claim('7007',new Date(Date.parse(now)+i*121000).toISOString());
  assert.equal(last.attempts,3);let called=false;
  const r=await processBriefing({db:store.db,briefings:repo,accountRef:'7007',now:new Date(Date.parse(now)+363000).toISOString(),generate:async()=>{called=true;}});
  assert.equal(r.mode,'rules');assert.equal(called,false);assert.equal(repo.complete(last,{},'ai',now),false);store.db.close();
});
test('briefing: API config generation auth and account isolation',async()=>{
  const {store,repo}=setup();const config={token:'synthetic',account_id:'7007'};
  const handler=createV2Handler({config,briefings:repo});
  const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost');if(!await handler(req,res,u.pathname,u.searchParams)){res.statusCode=404;res.end('{}');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const headers={Authorization:'Bearer synthetic','Content-Type':'application/json'};
  try{
    assert.equal((await fetch(base+'/v1/briefings')).status,401);
    assert.equal((await (await fetch(base+'/v1/briefing-settings',{headers})).json()).enabled,false);
    assert.equal((await fetch(base+'/v1/briefing-settings',{method:'PUT',headers,body:JSON.stringify({enabled:true,time:'99:00',time_zone:'UTC'})})).status,400);
    assert.equal((await fetch(base+'/v1/briefing-settings',{method:'PUT',headers,body:JSON.stringify({enabled:true,time:'08:00',time_zone:'UTC'})})).status,200);
    const a=await (await fetch(base+'/v1/briefings/today',{method:'POST',headers})).json();
    const b=await (await fetch(base+'/v1/briefings/today',{method:'POST',headers})).json();assert.equal(a.id,b.id);
    const other=repo.ensure('other',now,true);assert.equal((await fetch(base+'/v1/briefings/'+other.id,{headers})).status,404);
    assert.equal((await (await fetch(base+'/v1/briefings',{headers})).json()).items.length,1);
  }finally{await new Promise(resolve=>server.close(resolve));store.db.close();}
});
test('briefing: cloud call sends bounded source data and validates its output',async()=>{
  let body;const result=await generateBriefing({payload:{sources:[{ref:'todo:1',text:'示例待办'}]},apiKey:'fake',fetchImpl:async(url,options)=>{
    body=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({intro:'早上好',sections:[{title:'待办',items:[{text:'示例待办',ref:'todo:1'}]}]})}}]})};
  }});
  assert.equal(result.sections[0].items[0].ref,'todo:1');assert.equal(body.messages.length,2);assert.equal(JSON.stringify(body).includes('fake'),false);
});
test('briefing: trusted source links are attached by code instead of model supplied URLs',()=>{
  const value=validateBriefing({intro:'摘要',sections:[{title:'技术',items:[{text:'示例',ref:article.ref,url:'https://evil.example'}]}]},{sources:[article]});
  assert.equal(value.sections[0].items[0].url,article.url);
  assert.equal(value.sections[0].items[0].published_at,now);
});
test('briefing: empty recent sources never asks AI to invent news',async()=>{
  const {store,repo}=setup();repo.ensure('7007',now,true);let called=false;
  await processBriefing({db:store.db,briefings:repo,accountRef:'7007',now,collect:async()=>({sources:[],coverage:[]}),generate:async()=>{called=true;}});
  assert.equal(called,false);assert.equal(repo.list('7007')[0].error_class,'no_recent_sources');store.db.close();
});
test('briefing: all feeds temporarily unavailable retries instead of finalizing immediately',async()=>{
  const {store,repo}=setup();repo.ensure('7007',now,true);
  const collect=async()=>({sources:[],coverage:[{source:'Example',status:'unavailable',count:0}]});
  const result=await processBriefing({db:store.db,briefings:repo,accountRef:'7007',now,collect});
  assert.equal(result.state,'queued');assert.equal(repo.list('7007')[0].error_class,'sources_unavailable');
  store.db.close();
});
