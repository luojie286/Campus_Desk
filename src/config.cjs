// 配置校验只返回稳定的错误码，不回显令牌或任何秘密值。
const fs=require('node:fs');
const MIN_TOKEN_LENGTH=32;

function validateConfig(config,{allowUnconfigured=false}={}) {
  if(!config||typeof config!=='object'||Array.isArray(config))return {ok:false,errors:['config_invalid']};
  const errors=[];
  if(!Number.isInteger(config.port)||config.port<1||config.port>65535)errors.push('port_invalid');
  if(typeof config.token!=='string'||config.token.length<MIN_TOKEN_LENGTH)errors.push('token_invalid');
  if(typeof config.execute!=='boolean')errors.push('execute_invalid');
  if(config.messageCenter!==undefined&&typeof config.messageCenter!=='boolean')errors.push('messageCenter_invalid');
  if(config.pipeline!==undefined&&!['legacy','v2'].includes(config.pipeline))errors.push('pipeline_invalid');
  if(config.account_id!==undefined&&config.account_id!==null&&config.account_id!==''&&!/^\d+$/.test(String(config.account_id))){
    errors.push('account_id_invalid');
  }
  const source=config.source;
  if(!source||typeof source!=='object'||Array.isArray(source))errors.push('source_invalid');
  else{
    if(!['private','group'].includes(source.type))errors.push('source_type_invalid');
    // 首次运行时允许来源为空，服务仍可用于扫码和绑定；绑定后必须提供稳定 ID。
    if(typeof source.id!=='string'||(source.id===''&&!allowUnconfigured))errors.push('source_id_missing');
    if(source.type==='group'&&source.id!==''&&(typeof source.sender_id!=='string'||source.sender_id===''))errors.push('source_sender_missing');
    if(source.account_id!==undefined&&source.account_id!==null&&source.account_id!==''&&!/^\d+$/.test(String(source.account_id))){
      errors.push('source_account_id_invalid');
    }
  }
  for(const key of ['max_rows','max_read_rows','max_read_cols','max_clipboard_chars']){
    if(config[key]!==undefined&&(!Number.isInteger(config[key])||config[key]<=0))errors.push(key+'_invalid');
  }
  if(config.browser_profile!==undefined&&typeof config.browser_profile!=='string')errors.push('browser_profile_invalid');
  if(config.allowed_document!==undefined&&typeof config.allowed_document!=='string')errors.push('allowed_document_invalid');
  return {ok:errors.length===0,errors};
}

function loadConfig(file,options) {
  let config;
  try{config=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch{throw Error('config_json_invalid');}
  const result=validateConfig(config,options);
  if(!result.ok)throw Error('invalid_config:'+result.errors.join(','));
  return config;
}

module.exports={validateConfig,loadConfig,MIN_TOKEN_LENGTH};
