// 持久化任务队列：短事务领取、租约过期回收、失败重试；浏览器操作仍在事务外执行。
function createJobRepository(db){
  const nowIso=()=>new Date().toISOString();
  return {
    enqueue({type,payload={},runAt=nowIso(),maxAttempts=5}){
      const info=db.prepare(`INSERT INTO jobs
        (type,payload_json,run_at,attempts,max_attempts,state,created_at,updated_at)
        VALUES(?,?,?,0,?,'queued',?,?)`)
        .run(String(type),JSON.stringify(payload||{}),runAt,Number(maxAttempts),runAt,runAt);
      return Number(info.lastInsertRowid);
    },
    claim({workerId,leaseSeconds=60,now=nowIso()}){
      db.exec('BEGIN IMMEDIATE');
      try{
        const candidate=db.prepare("SELECT id FROM jobs WHERE state='queued' AND run_at<=? ORDER BY id LIMIT 1").get(now);
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
