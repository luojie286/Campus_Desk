const crypto=require('node:crypto');
const {DEFAULT_SETTINGS,validateSettings,localClock}=require('./core.cjs');
function mapBriefing(row){
  if(!row)return null;
  return {id:row.id,local_date:row.local_date,time_zone:row.time_zone,state:row.state,mode:row.mode,
    content:row.content_json?JSON.parse(row.content_json):null,error_class:row.error_class,created_at:row.created_at,generated_at:row.generated_at};
}
function createBriefingRepository(db){
  const repo={
    settings(accountRef){const r=db.prepare('SELECT * FROM briefing_settings WHERE account_ref=?').get(accountRef);return r?{enabled:!!r.enabled,time:r.time,time_zone:r.time_zone}:{...DEFAULT_SETTINGS};},
    saveSettings(accountRef,value){const s=validateSettings(value);db.prepare('INSERT OR REPLACE INTO briefing_settings(account_ref,enabled,time,time_zone) VALUES(?,?,?,?)').run(accountRef,Number(s.enabled),s.time,s.time_zone);return s;},
    ensure(accountRef,now,requested=false){
      const s=repo.settings(accountRef),clock=localClock(now,s.time_zone);
      db.prepare(`INSERT OR IGNORE INTO briefings(account_ref,local_date,time_zone,state,requested,created_at) VALUES(?,?,?,'queued',?,?)`)
        .run(accountRef,clock.date,s.time_zone,Number(requested),now);
      if(requested)db.prepare('UPDATE briefings SET requested=1 WHERE account_ref=? AND local_date=?').run(accountRef,clock.date);
      return db.prepare('SELECT * FROM briefings WHERE account_ref=? AND local_date=?').get(accountRef,clock.date);
    },
    claim(accountRef,now){
      const settings=repo.settings(accountRef),clock=localClock(now,settings.time_zone);
      if(settings.enabled&&clock.time>=settings.time)repo.ensure(accountRef,now);
      const owner=crypto.randomUUID(),until=new Date(Date.parse(now)+120000).toISOString();
      // 条件 UPDATE 是领取边界；不同进程也不能同时持有同一份早报。
      const result=db.prepare(`UPDATE briefings SET state='generating',attempts=attempts+1,lease_owner=?,lease_until=?
        WHERE account_ref=? AND local_date=?
        AND ((state='queued' AND attempts<3 AND (retry_at IS NULL OR retry_at<=?)) OR (state='generating' AND lease_until<=?))
        AND (requested=1 OR ?=1)`).run(owner,until,accountRef,clock.date,now,now,Number(settings.enabled&&clock.time>=settings.time));
      if(!result.changes)return null;
      return db.prepare('SELECT * FROM briefings WHERE lease_owner=?').get(owner);
    },
    complete(row,content,mode,now,error=null){return db.prepare(`UPDATE briefings SET state='ready',content_json=?,mode=?,generated_at=?,error_class=?,lease_owner=NULL,lease_until=NULL
      WHERE id=? AND state='generating' AND lease_owner=?`).run(JSON.stringify(content),mode,now,error,row.id,row.lease_owner).changes===1;},
    retry(row,now,error){db.prepare(`UPDATE briefings SET state='queued',retry_at=?,error_class=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?`)
      .run(new Date(Date.parse(now)+300000).toISOString(),error,row.id,row.lease_owner);},
    list(accountRef){return db.prepare('SELECT * FROM briefings WHERE account_ref=? ORDER BY local_date DESC LIMIT 30').all(accountRef).map(mapBriefing);},
    get(accountRef,id){return mapBriefing(db.prepare('SELECT * FROM briefings WHERE account_ref=? AND id=?').get(accountRef,Number(id)));}
  };return repo;
}
module.exports={createBriefingRepository,mapBriefing};
