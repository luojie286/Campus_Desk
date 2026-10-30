// OneBot/NapCat 文件下载适配器：优先使用 base64，其次允许 NapCat 数据目录内的本地路径，
// 最后才使用临时 HTTP URL。本地路径必须通过白名单，避免读取任意文件。
const fs=require('node:fs');
const path=require('node:path');
const {fileURLToPath}=require('node:url');
const DEFAULT_API_BASE='http://127.0.0.1:9088';

function stripDataUrl(value){
  const text=String(value||'');
  const comma=text.indexOf(',');
  return text.startsWith('data:')&&comma>=0?text.slice(comma+1):text;
}

function localPathOf(value){
  const text=String(value||'');
  try{
    if(text.startsWith('file://'))return fileURLToPath(text);
  }catch{return null;}
  if(/^[A-Za-z]:[\\/]/.test(text)||text.startsWith('\\\\'))return text;
  return null;
}

function isAllowedLocalPath(filePath,config){
  let real;
  try{real=fs.realpathSync(filePath);}
  catch{return false;}
  const roots=config.files?.allowed_roots||config.onebot?.allowed_roots||[];
  if(roots.length){
    return roots.some(root=>{
      let realRoot;
      try{realRoot=fs.realpathSync(root);}
      catch{realRoot=path.resolve(root);}
      return real===realRoot||real.startsWith(realRoot+path.sep);
    });
  }
  // 没有显式白名单时，只接受 NapCat 的 Tencent Files/NapCat 数据目录。
  const parts=real.toLowerCase().split(/[\\/]+/);
  return parts.includes('tencent files')&&parts.includes('napcat');
}

async function downloadOneBotFile({fileId,fileName,config={},fetchImpl=fetch}){
  const base=String(config.onebot?.api_base||DEFAULT_API_BASE).replace(/\/+$/,'');
  const token=config.onebot?.token||config.token;
  if(!token)throw Error('onebot_token_missing');
  const response=await fetchImpl(base+'/get_file',{
    method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({file_id:fileId,file:fileName}),
    signal:AbortSignal.timeout(30000)
  });
  if(!response.ok)throw Error('onebot_get_file_http_'+response.status);
  let json;
  try{json=await response.json();}catch{throw Error('onebot_get_file_invalid_json');}
  if(json?.status!=='ok')throw Error('onebot_get_file_failed');
  const data=json.data||{};
  if(data.base64)return Buffer.from(stripDataUrl(data.base64),'base64');
  if(data.url){
    const local=localPathOf(data.url);
    if(local){
      if(!fs.existsSync(local))throw Error('onebot_local_file_missing');
      if(!isAllowedLocalPath(local,config))throw Error('file_path_not_allowed');
      return fs.readFileSync(local);
    }
    const fileResponse=await fetchImpl(String(data.url),{signal:AbortSignal.timeout(30000)});
    if(!fileResponse.ok)throw Error('onebot_file_http_'+fileResponse.status);
    return Buffer.from(await fileResponse.arrayBuffer());
  }
  throw Error('onebot_file_content_missing');
}

module.exports={downloadOneBotFile};
