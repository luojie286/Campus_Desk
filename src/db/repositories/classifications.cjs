// 分类结果独立于消息保存；纠正分类不改原文。
function createClassificationRepository(db){
  return {
    insert({messageId,messageVersion=1,category,confidence=null,ruleId=null,model='rules',rationale=null,status='auto',createdAt=new Date().toISOString()}){
      const info=db.prepare(`INSERT INTO classifications
        (message_id,message_version,category,confidence,rule_id,model,rationale,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(Number(messageId),Number(messageVersion),String(category),confidence,ruleId,String(model),rationale,String(status),createdAt);
      return Number(info.lastInsertRowid);
    },
    latestForMessage(messageId){
      return db.prepare('SELECT * FROM classifications WHERE message_id=? ORDER BY id DESC LIMIT 1')
        .get(Number(messageId))||null;
    },
    listForMessage(messageId){
      return db.prepare('SELECT * FROM classifications WHERE message_id=? ORDER BY id DESC')
        .all(Number(messageId));
    }
  };
}

module.exports={createClassificationRepository};
