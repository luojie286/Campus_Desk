// 持久化任务队列：短事务领取、租约过期回收、失败重试；浏览器操作仍在事务外执行。
function createJobRepository(db){
  const nowIso=()=>new Date().toISOString();
  return {
    enqueue({type,payload={},runAt=nowIso(),maxAttempts=5,dedupeKey=null}){
      const info=db.prepare(`INSERT INTO jobs
        (type,payload_json,run_at,attempts,max_attempts,state,dedupe_key,created_at,updated_at)
        VALUES(?,?,?,0,?,'queued',?,?,?)`)
        .run(String(type),JSON.stringify(payload||{}),runAt,Number(maxAttempts),
          dedupeKey===null?null:String(dedupeKey),runAt,runAt);
      return Number(info.lastInsertRowid);
    },
    // 同一会话的短时间消息共用一个 queued job；后到的消息把执行时间往后推。
    // stealExpired：租约已过期的 running job 可被重新排队，避免服务长期运行时旧 job 永久占住 dedupeKey。
    enqueueUnique({type,payload={},runAt=nowIso(),maxAttempts=5,dedupeKey,stealExpired=false,now=nowIso()}){
      if(!dedupeKey)throw Error('dedupe_key_required');
      db.exec('BEGIN IMMEDIATE');
      try{
        const existing=db.prepare(`SELECT * FROM jobs
          WHERE dedupe_key=? AND state IN ('queued','running') ORDER BY id LIMIT 1`).get(String(dedupeKey));
        if(existing){
          if(existing.state==='queued'){
            db.prepare('UPDATE jobs SET run_at=?,payload_json=?,updated_at=? WHERE id=?')
              .run(runAt,JSON.stringify(payload||{}),now,existing.id);
          }else if(stealExpired&&existing.lease_expires_at&&existing.lease_expires_at<=now){
            // 只回收确认过期的租约；不要抢占仍在执行中的 job。
            db.prepare(`UPDATE jobs SET state='queued',run_at=?,payload_json=?,lease_owner=NULL,
              lease_expires_at=NULL,updated_at=? WHERE id=?`)
              .run(runAt,JSON.stringify(payload||{}),now,existing.id);
          }
          db.exec('COMMIT');
          return Number(existing.id);
        }
        const info=db.prepare(`INSERT INTO jobs
          (type,payload_json,run_at,attempts,max_attempts,state,dedupe_key,created_at,updated_at)
          VALUES(?,?,?,0,?,'queued',?,?,?)`)
          .run(String(type),JSON.stringify(payload||{}),runAt,Number(maxAttempts),
            String(dedupeKey),runAt,runAt);
        db.exec('COMMIT');
        return Number(info.lastInsertRowid);
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
    },
    claim({workerId,leaseSeconds=60,now=nowIso(),type=null}){
      db.exec('BEGIN IMMEDIATE');
      try{
        // worker 只领取自己负责的类型；否则 prepare_task 会被分类 worker 误领并失败。
        const candidate=type
          ? db.prepare("SELECT id FROM jobs WHERE state='queued' AND run_at<=? AND type=? ORDER BY id LIMIT 1").get(now,String(type))
          : db.prepare("SELECT id FROM jobs WHERE state='queued' AND run_at<=? ORDER BY id LIMIT 1").get(now);
        if(!candidate){db.exec('COMMIT');return null;}
        const leaseExpires=new Date(new Date(now).getTime()+Number(leaseSeconds)*1000).toISOString();
        const updated=db.prepare(`UPDATE jobs SET state='running',lease_owner=?,lease_expires_at=?,
          attempts=attempts+1,updated_at=? WHERE id=? AND state='queued'`)
          .run(String(workerId),leaseExpires,now,candidate.id);
        if(updated.changes!==1){db.exec('COMMIT');return null;}
        const job=db.prepare('SELECT * FROM jobs WHERE id=?').get(candidate.id);
        db.exec('COMMIT');
        return job;
      }catch(error){
        db.exec('ROLLBACK');
        throw error;
      }
    },
    complete(id,now=nowIso()){
      return db.prepare("UPDATE jobs SET state='done',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='running'")
        .run(now,Number(id)).changes===1;
    },
    fail(id,error,{retryDelaySeconds=30,now=nowIso()}={}){
      const job=db.prepare('SELECT * FROM jobs WHERE id=?').get(Number(id));
      if(!job)throw Error('job_not_found');
      const message=String(error||'unknown').split('\n')[0].slice(0,200);
      if(job.attempts>=job.max_attempts){
        db.prepare("UPDATE jobs SET state='failed',last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?")
          .run(message,now,Number(id));
        return 'failed';
      }
      const runAt=new Date(new Date(now).getTime()+Number(retryDelaySeconds)*1000).toISOString();
      db.prepare("UPDATE jobs SET state='queued',run_at=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?")
        .run(runAt,message,now,Number(id));
      return 'queued';
    },
    recoverExpired(now=nowIso()){
      return db.prepare("UPDATE jobs SET state='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE state='running' AND lease_expires_at<?")
        .run(now,now).changes;
    }
  };
}

module.exports={createJobRepository};
