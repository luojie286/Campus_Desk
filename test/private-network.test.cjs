const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {openStore}=require('../src/core.cjs');
const {applyMigrations,MIGRATIONS}=require('../src/db/migrate.cjs');
const {createDeviceRepository}=require('../src/network/devices.cjs');
const {createGateway,scopeFor}=require('../src/network/gateway.cjs');
const {createV2Handler}=require('../src/api/v2.cjs');

function repository(t){
  const store=openStore(':memory:');applyMigrations(store.db);t.after(()=>store.db.close());
  let clock=Date.parse('2026-11-03T00:00:00Z');
  const devices=createDeviceRepository(store.db,{now:()=>clock});
  return {devices,db:store.db,advance:ms=>{clock+=ms;}};
}
test('pairing: secrets are only hashed and invitations can be consumed once',t=>{
  const {devices,db}=repository(t),invite=devices.invite('account-a');
  assert.equal(invite.code.length,43);
  const paired=devices.redeem(invite.code,'测试手机','account-a');assert.ok(paired);
  assert.equal(devices.redeem(invite.code,'另一个设备','account-a'),null);
  const stored=JSON.stringify({device:db.prepare('SELECT * FROM devices').get(),code:db.prepare('SELECT * FROM pairing_codes').get()});
  assert.ok(!stored.includes(invite.code));assert.ok(!stored.includes(paired.token));
  assert.equal(devices.authenticate(paired.token,'account-a').id,paired.device_id);
  assert.ok(!JSON.stringify(devices.list('account-a')).includes('token'));
});
test('pairing: expires and is bound to the account',t=>{
  const {devices,advance}=repository(t),invite=devices.invite('a');
  assert.equal(devices.redeem(invite.code,'手机','b'),null);
  assert.equal(devices.redeem('short','手机','a'),null);
  assert.equal(devices.redeem(invite.code,'','a'),null);
  advance(300_000);assert.equal(devices.redeem(invite.code,'手机','a'),null);
});
test('devices: account isolation revocation and expiration',t=>{
  const {devices,advance}=repository(t);
  const one=devices.redeem(devices.invite('a').code,'手机一','a');
  const two=devices.redeem(devices.invite('a',{readOnly:true}).code,'手机二','a');
  assert.equal(devices.authenticate(one.token,'b'),null);assert.deepEqual(devices.list('b'),[]);
  assert.equal(devices.revoke(one.device_id,'b'),false);
  assert.equal(devices.revoke(one.device_id,'a'),true);assert.equal(devices.authenticate(one.token,'a'),null);
  assert.equal(devices.authenticate(two.token,'a').scopes,'mobile:read');
  advance(90*86400_000);assert.equal(devices.authenticate(two.token,'a'),null);
});
test('devices: old unbound placeholder devices gain no access after migration',t=>{
  const store=openStore(':memory:');t.after(()=>store.db.close());
  for(const migration of MIGRATIONS.filter(x=>x.version<9))migration.up(store.db);
  store.db.prepare(`INSERT INTO devices(id,name,platform,token_hash,token_prefix,paired_at) VALUES('old','old','android','oldhash','prefix','2026-01-01')`).run();
  MIGRATIONS.find(x=>x.version===9).up(store.db);
  assert.deepEqual(createDeviceRepository(store.db).list('a'),[]);
});
async function listen(t,server){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t,{authorizeAccount}={}){
  const {devices,advance}=repository(t),seen=[];
  const upstream=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    seen.push({url:req.url,method:req.method,headers:req.headers,body});
    res.setHeader('Set-Cookie','must-not-forward=1');
    if(req.url==='/v1/tasks/77'){res.writeHead(302,{Location:'http://example.invalid'});res.end();return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:[],ok:true}));
  });
  await listen(t,upstream);
  const config={account_id:'account-a',port:upstream.address().port,token:'owner-secret-not-a-device-token-xxxxxxxxxxx'};
  const gateway=createGateway({devices,getConfig:()=>config,authorizeAccount}),base=await listen(t,gateway);
  const code=devices.invite(config.account_id).code;
  const token=devices.redeem(code,'手机',config.account_id).token;
  const request=(path,options={})=>fetch(base+path,{...options,redirect:'manual',headers:{Authorization:'Bearer '+token,...options.headers}});
  return {devices,advance,seen,config,base,token,request};
}
test('gateway: only mobile routes are exposed and owner token is not accepted',async t=>{
  const {request,config,seen}=await fixture(t);
  for(const path of ['/v1/runs','/setup/anything','/onebot/event','/v1/listen-sources','/v1/messages','/v1/contacts'])
    assert.equal((await request(path)).status,404,path);
  assert.equal((await request('/v1/tasks',{headers:{Authorization:'Bearer '+config.token}})).status,401);
  assert.equal((await request('/v1/tasks',{headers:{Authorization:''}})).status,401);
  assert.equal(seen.length,0);
});
test('gateway: safe forwarding replaces bearer strips cookies and preserves reviewed approval',async t=>{
  const {request,seen,config}=await fixture(t);
  const body=JSON.stringify({plan_id:8,plan_version:2,plan_digest:'reviewed',client_request_id:'unique'});
  const response=await request('/v1/tasks/7/approvals',{method:'POST',body,headers:{Cookie:'private=1','X-Campus-Account':'spoof','Tailscale-User-Login':'spoof'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(seen.length,1);assert.equal(seen[0].body,body);
  assert.equal(seen[0].headers.authorization,'Bearer '+config.token);
  assert.equal(seen[0].headers['x-campus-account'],config.account_id);
  assert.equal(seen[0].headers.cookie,undefined);assert.equal(seen[0].headers['tailscale-user-login'],undefined);
});
test('gateway: read-only device cannot mutate and revoked device fails immediately',async t=>{
  const {devices,request,config,seen}=await fixture(t);
  const read=devices.redeem(devices.invite(config.account_id,{readOnly:true}).code,'只读手机',config.account_id);
  const headers={Authorization:'Bearer '+read.token};
  assert.equal((await request('/v1/tasks',{headers})).status,200);
  assert.equal((await request('/v1/tasks/1/cancel',{method:'POST',body:'{}',headers})).status,403);
  devices.revoke(read.device_id,config.account_id);
  assert.equal((await request('/v1/tasks',{headers})).status,401);
  assert.equal(seen.length,1);
});
test('gateway: account changes stop old device before upstream access',async t=>{
  const {config,request,seen}=await fixture(t);config.account_id='account-b';
  assert.equal((await request('/v1/tasks')).status,401);assert.equal(seen.length,0);
});
test('gateway: revoked workspace binding blocks an existing paired device',async t=>{
  const {request,seen}=await fixture(t,{authorizeAccount:()=>false});
  assert.equal((await request('/v1/tasks')).status,403);
  assert.equal(seen.length,0);
});
test('gateway: concurrent pairing succeeds exactly once and rejects invalid JSON',async t=>{
  const {devices,config,base}=await fixture(t),code=devices.invite(config.account_id).code;
  const options={method:'POST',body:JSON.stringify({code,name:'手机'})};
  const responses=await Promise.all(Array.from({length:4},()=>fetch(base+'/v1/device-pairings',options)));
  assert.deepEqual(responses.map(x=>x.status).sort(),[201,401,401,401]);
  assert.equal((await fetch(base+'/v1/device-pairings',{method:'POST',body:'broken'})).status,400);
});
test('gateway: pairing rate limit has no credential-dependent bypass',async t=>{
  const {base}=await fixture(t);
  for(let i=0;i<20;i++)assert.equal((await fetch(base+'/v1/device-pairings',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(base+'/v1/device-pairings',{method:'POST',body:'{}'})).status,429);
});
test('gateway: oversized input is rejected and redirects never followed',async t=>{
  const {request,base,seen}=await fixture(t);
  assert.equal((await fetch(base+'/v1/device-pairings',{method:'POST',body:'x'.repeat(4097)})).status,413);
  assert.equal((await request('/v1/tasks/1/answers',{method:'POST',body:'x'.repeat(65537)})).status,413);
  assert.equal((await request('/v1/tasks/77')).status,502);assert.equal(seen.length,1);
});
test('gateway: encoded paths and unavailable mutation actions fail closed',async t=>{
  const {request,seen}=await fixture(t);
  assert.equal((await request('/v1/tasks/%31')).status,400);
  for(const action of ['resume','reconcile','operations','plan'])assert.equal(scopeFor('POST','/v1/tasks/1/'+action),null);
  assert.equal(scopeFor('DELETE','/v1/tasks/1'),null);assert.equal(seen.length,0);
});
test('gateway: backend rejects stale-account forwarding despite a valid owner token',async()=>{
  const handle=createV2Handler({config:{token:'owner',account_id:'b'}});
  let code,body;
  const res={setHeader(){},set statusCode(value){code=value;},end(value){body=JSON.parse(value);}};
  await handle({headers:{authorization:'Bearer owner','x-campus-account':'a'},method:'GET'},res,'/v1/tasks',new URLSearchParams());
  assert.equal(code,409);assert.equal(body.error,'gateway_account_mismatch');
});
test('gateway: oversized upstream and failed mutations never leak or retry',async t=>{
  const {devices}=repository(t);let calls=0;
  const config={account_id:'a',port:19087,token:'owner'};
  const token=devices.redeem(devices.invite('a').code,'手机','a').token;
  const server=createGateway({devices,getConfig:()=>config,fetchImpl:async(_url,options)=>{
    calls++;
    if(options.method==='POST')throw Error('private-owner-and-platform-error');
    return new Response('x'.repeat(4*1024*1024+1));
  }});
  const base=await listen(t,server),headers={Authorization:'Bearer '+token};
  const read=await fetch(base+'/v1/tasks',{headers});assert.equal(read.status,502);
  assert.deepEqual(await read.json(),{error:'gateway_unavailable'});
  const write=await fetch(base+'/v1/tasks/1/approvals',{method:'POST',headers,body:'{}'});
  assert.equal(write.status,502);assert.deepEqual(await write.json(),{error:'gateway_unavailable'});assert.equal(calls,2);
});
