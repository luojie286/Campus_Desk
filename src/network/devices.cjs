const crypto=require('node:crypto');

const secret=()=>crypto.randomBytes(32).toString('base64url');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const validSecret=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const publicDevice=row=>({id:row.id,name:row.name,platform:row.platform,scopes:row.scopes,
  paired_at:row.paired_at,last_seen_at:row.last_seen_at,expires_at:row.expires_at,revoked_at:row.revoked_at});

function createDeviceRepository(db,{now=()=>Date.now()}={}){
  function invite(accountRef,{readOnly=false}={}){
    if(!accountRef)throw Error('account_not_configured');
    const code=secret(),created=new Date(now()).toISOString(),expires=new Date(now()+5*60_000).toISOString();
    db.prepare(`INSERT INTO pairing_codes(code_hash,expires_at,created_at,account_ref,scopes) VALUES(?,?,?,?,?)`)
      .run(hash(code),expires,created,String(accountRef),readOnly?'mobile:read':'mobile:read,mobile:act');
    return {code,expires_at:expires};
  }
  function redeem(code,name,accountRef){
    if(!validSecret(code)||typeof name!=='string'||!name.trim()||name.length>80)return null;
    const stamp=new Date(now()).toISOString();
    // 校验、消费邀请和创建设备在同一个写事务中完成，其他进程不能重复兑换。
    db.exec('BEGIN IMMEDIATE');
    try{
      const row=db.prepare(`SELECT * FROM pairing_codes WHERE code_hash=? AND consumed_at IS NULL
        AND expires_at>? AND account_ref=?`).get(hash(code),stamp,String(accountRef));
      if(!row){db.exec('ROLLBACK');return null;}
      const token=secret(),id=crypto.randomUUID(),expires=new Date(now()+90*86400_000).toISOString();
      db.prepare('UPDATE pairing_codes SET consumed_at=? WHERE code_hash=?').run(stamp,row.code_hash);
      db.prepare(`INSERT INTO devices(id,name,platform,token_hash,token_prefix,scopes,paired_at,account_ref,expires_at)
        VALUES(?,?,'android',?,?,?,?,?,?)`).run(id,name.trim(),hash(token),token.slice(0,6),row.scopes,stamp,String(accountRef),expires);
      db.exec('COMMIT');
      return {device_id:id,token,expires_at:expires,scopes:row.scopes};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function authenticate(token,accountRef){
    if(!validSecret(token)||!accountRef)return null;
    const stamp=new Date(now()).toISOString();
    const row=db.prepare(`SELECT * FROM devices WHERE token_hash=? AND account_ref=? AND revoked_at IS NULL
      AND expires_at>?`).get(hash(token),String(accountRef),stamp);
    if(!row)return null;
    // 最多每分钟更新一次，避免每次手机轮询都产生 SQLite 写入。
    if(!row.last_seen_at||Date.parse(row.last_seen_at)<now()-60_000)
      db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(stamp,row.id);
    return publicDevice(row);
  }
  function list(accountRef){return db.prepare('SELECT * FROM devices WHERE account_ref=? ORDER BY paired_at DESC').all(String(accountRef)).map(publicDevice);}
  function revoke(id,accountRef){return db.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND account_ref=? AND revoked_at IS NULL')
    .run(new Date(now()).toISOString(),id,String(accountRef)).changes===1;}
  return {invite,redeem,authenticate,list,revoke};
}
module.exports={createDeviceRepository};
