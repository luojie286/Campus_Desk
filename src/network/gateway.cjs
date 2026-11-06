const http=require('node:http');

function send(res,status,value){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(value));
}
async function readBody(req,max){
  const chunks=[];let size=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})){
    size+=chunk.length;if(size>max){req.resume();throw Error('body_too_large');}chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function scopeFor(method,path){
  if(method==='GET'&&(/^\/v1\/(suggestions|tasks|todos|briefings|briefing-settings)$/.test(path)||/^\/v1\/(tasks|briefings)\/[1-9]\d*$/.test(path)))return 'mobile:read';
  if(method==='PUT'&&path==='/v1/briefing-settings')return 'mobile:act';
  if(method==='POST'&&(/^\/v1\/suggestions\/[1-9]\d*\/(accept|dismiss)$/.test(path)||
    /^\/v1\/todos\/[1-9]\d*\/(complete|reopen|delete)$/.test(path)||
    /^\/v1\/tasks\/[1-9]\d*\/(answers|approvals|cancel)$/.test(path)||path==='/v1/briefings/today'))return 'mobile:act';
  return null;
}

function createGateway({devices,getConfig,authorizeAccount=()=>true,fetchImpl=fetch}){
  let pairingWindow=0,pairingAttempts=0;
  const server=http.createServer(async(req,res)=>{
    try{
      // 只接受原始 origin-form 路径；禁用编码路径和点路径，避免代理层解释差异。
      const raw=req.url||'';
      if(!raw.startsWith('/')||raw.startsWith('//')||raw.length>2048||/[\\%#]/.test(raw.split('?')[0])||raw.split('?')[0].split('/').some(x=>x==='.'||x==='..')){
        send(res,400,{error:'invalid_path'});return;
      }
      const url=new URL(raw,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/health'){send(res,200,{running:true,service:'mobile-gateway'});return;}
      const config=getConfig();
      if(!config.account_id){send(res,503,{error:'account_not_configured'});return;}
      if(!authorizeAccount(String(config.account_id))){send(res,403,{error:'workspace_source_unavailable'});return;}
      if(req.method==='POST'&&url.pathname==='/v1/device-pairings'){
        // Serve 转发后多个手机可能都显示回环地址，采用全局上限而非信任客户端 IP 头。
        const window=Math.floor(Date.now()/60_000);
        if(window!==pairingWindow){pairingWindow=window;pairingAttempts=0;}
        if(++pairingAttempts>20){send(res,429,{error:'pairing_rate_limited'});return;}
        const body=JSON.parse((await readBody(req,4096)).toString('utf8'));
        const result=devices.redeem(body.code,body.name,String(config.account_id));
        send(res,result?201:401,result||{error:'pairing_invalid_or_expired'});return;
      }
      const required=scopeFor(req.method,url.pathname);
      if(!required){send(res,404,{error:'route_not_available'});return;}
      const auth=req.headers.authorization||'';
      const device=devices.authenticate(auth.startsWith('Bearer ')?auth.slice(7):'',String(config.account_id));
      if(!device){send(res,401,{error:'device_unauthorized'});return;}
      if(!device.scopes.split(',').includes(required)){send(res,403,{error:'device_scope_denied'});return;}
      const body=req.method==='GET'?undefined:await readBody(req,65536);
      // 上游严格固定到本机端口；忽略客户端 Cookie、Host、身份头和所有转发头。
      if(!Number.isInteger(config.port)||config.port<1||config.port>65535||config.port===9090||!config.token)throw Error('upstream_invalid');
      const upstream=await fetchImpl(`http://127.0.0.1:${config.port}${url.pathname}${url.search}`,{
        method:req.method,headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json','X-Campus-Account':String(config.account_id)},
        body,redirect:'manual',signal:AbortSignal.timeout(25_000)
      });
      if(upstream.status>=300&&upstream.status<400){send(res,502,{error:'upstream_redirect_blocked'});return;}
      const chunks=[];let size=0;
      if(upstream.body)for await(const chunk of upstream.body){
        size+=chunk.length;
        // 退出异步迭代会关闭上游流，不继续缓存超大的响应。
        if(size>4*1024*1024)throw Error('upstream_too_large');
        chunks.push(chunk);
      }
      // 只转发 JSON，响应中的 Cookie、Location、CORS 等不会穿透到手机。
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      send(res,upstream.status,result);
    }catch(error){
      if(!res.headersSent)send(res,error.message==='body_too_large'?413:error instanceof SyntaxError?400:502,
        {error:error.message==='body_too_large'?'body_too_large':error instanceof SyntaxError?'invalid_json':'gateway_unavailable'});
      else res.destroy();
    }
  });
  server.requestTimeout=10_000;server.headersTimeout=10_000;server.keepAliveTimeout=5000;
  return server;
}
module.exports={createGateway,scopeFor};
