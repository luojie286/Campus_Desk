// 附件仓储：记录下载/文字提取状态，路径写入 .private，不把文件正文放进消息表。
function createFileRepository(db){
  const nowIso=()=>new Date().toISOString();
  const getRow=({id,accountRef})=>db.prepare('SELECT * FROM message_files WHERE id=? AND account_ref=?')
    .get(Number(id),String(accountRef))||null;
  return {
    insert({messageId,accountRef,platformFileId=null,fileName=null,mimeType=null,sizeBytes=null,createdAt=nowIso()}){
      const fileId=String(platformFileId||fileName||'unknown');
      const existing=db.prepare('SELECT * FROM message_files WHERE message_id=? AND platform_file_id=?')
        .get(Number(messageId),fileId);
      if(existing)return {...existing,created:false};
      const info=db.prepare(`INSERT INTO message_files
        (message_id,account_ref,platform_file_id,file_name,mime_type,size_bytes,download_state,text_state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'pending','pending',?,?)`)
        .run(Number(messageId),String(accountRef),fileId,
          fileName===null?null:String(fileName),mimeType===null?null:String(mimeType),
          sizeBytes===null?null:Number(sizeBytes),createdAt,createdAt);
      return {...db.prepare('SELECT * FROM message_files WHERE id=?').get(Number(info.lastInsertRowid)),created:true};
    },
    get({id,accountRef}){return getRow({id,accountRef});},
    listForMessage({messageId,accountRef}){
      return db.prepare('SELECT * FROM message_files WHERE message_id=? AND account_ref=? ORDER BY id')
        .all(Number(messageId),String(accountRef));
    },
    markDownloaded({id,sha256,localPath,sizeBytes,now=nowIso()}){
      db.prepare(`UPDATE message_files SET download_state='downloaded',sha256=?,local_path=?,
        size_bytes=?,error=NULL,updated_at=? WHERE id=?`)
        .run(String(sha256),String(localPath),Number(sizeBytes),now,Number(id));
      return db.prepare('SELECT * FROM message_files WHERE id=?').get(Number(id));
    },
    markDownloadFailed({id,error,now=nowIso()}){
      db.prepare("UPDATE message_files SET download_state='failed',error=?,updated_at=? WHERE id=?")
        .run(String(error).slice(0,200),now,Number(id));
    },
    markTextExtracted({id,textPath,now=nowIso()}){
      // 能提取文字就说明文件已经成功取得；顺手修正前一次失败留下的下载状态。
      db.prepare(`UPDATE message_files SET text_state='extracted',download_state='downloaded',
        text_path=?,error=NULL,updated_at=? WHERE id=?`)
        .run(String(textPath),now,Number(id));
      return db.prepare('SELECT * FROM message_files WHERE id=?').get(Number(id));
    },
    markTextEmpty({id,now=nowIso()}){
      db.prepare("UPDATE message_files SET text_state='empty',error=NULL,updated_at=? WHERE id=?")
        .run(now,Number(id));
    },
    markTextUnsupported({id,reason,now=nowIso()}){
      db.prepare("UPDATE message_files SET text_state='unsupported',error=?,updated_at=? WHERE id=?")
        .run(String(reason).slice(0,200),now,Number(id));
    },
    markTextFailed({id,error,now=nowIso()}){
      db.prepare("UPDATE message_files SET text_state='failed',error=?,updated_at=? WHERE id=?")
        .run(String(error).slice(0,200),now,Number(id));
    }
  };
}

module.exports={createFileRepository};
