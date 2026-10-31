// 站内通知：只保存系统事件（如附件格式不支持），不存第三方推送令牌。
function createNotificationRepository(db){
  const nowIso=()=>new Date().toISOString();
  return {
    insert({accountRef,kind,title,body=null,createdAt=nowIso()}){
      const info=db.prepare(`INSERT INTO notifications(account_ref,kind,title,body,created_at)
        VALUES(?,?,?,?,?)`)
        .run(String(accountRef),String(kind),String(title),body===null?null:String(body),createdAt);
      return Number(info.lastInsertRowid);
    },
    list({accountRef,unreadOnly=false,limit=50}){
      let where='account_ref=?';const params=[String(accountRef)];
      if(unreadOnly){where+=' AND read_at IS NULL';}
      return db.prepare(`SELECT * FROM notifications WHERE ${where}
        ORDER BY created_at DESC,id DESC LIMIT ?`)
        .all(...params,Math.min(Math.max(Number(limit)||50,1),100));
    },
    unreadCount({accountRef}){
      return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE account_ref=? AND read_at IS NULL')
        .get(String(accountRef)).n;
    },
    markRead({id,accountRef,readAt=nowIso()}){
      return db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND account_ref=? AND read_at IS NULL')
        .run(readAt,Number(id),String(accountRef)).changes===1;
    }
  };
}

module.exports={createNotificationRepository};
