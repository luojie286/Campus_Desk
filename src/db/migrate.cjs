// 增量迁移只做加表和索引，不删除或重写旧 profile/runs/reservations。
// 每个版本在一个事务内完成，失败回滚；重复执行是幂等的。
const MIGRATIONS=[
  {
    version:1,
    name:'v2_core',
    up(db){
      db.exec(`
        CREATE TABLE IF NOT EXISTS sources(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          platform TEXT NOT NULL,
          account_ref TEXT NOT NULL,
          adapter_instance TEXT NOT NULL,
          conversation_type TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          sender_id TEXT NOT NULL DEFAULT '',
          display_name TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          auto_prepare INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(platform,account_ref,conversation_type,conversation_id,sender_id)
        );
        CREATE TABLE IF NOT EXISTS adapters(
          adapter_instance TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          account_ref TEXT NOT NULL,
          kind TEXT NOT NULL,
          version TEXT,
          capabilities_json TEXT,
          status TEXT NOT NULL DEFAULT 'untested',
          last_heartbeat_at TEXT,
          last_event_at TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inbound_events(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          adapter_instance TEXT NOT NULL,
          event_id TEXT NOT NULL,
          event_type TEXT,
          received_at TEXT NOT NULL,
          raw_sha256 TEXT,
          status TEXT NOT NULL DEFAULT 'stored',
          UNIQUE(adapter_instance,event_id)
        );
        CREATE TABLE IF NOT EXISTS messages(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          platform TEXT NOT NULL,
          adapter_instance TEXT NOT NULL,
          account_ref TEXT NOT NULL,
          conversation_type TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          source_time TEXT,
          received_at TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'text',
          content_text TEXT,
          content_json TEXT,
          link_json TEXT,
          completeness TEXT,
          identity_quality TEXT,
          read_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(platform,account_ref,conversation_type,conversation_id,source_message_id)
        );
        CREATE TABLE IF NOT EXISTS message_versions(
          message_id INTEGER NOT NULL,
          version INTEGER NOT NULL,
          content_text TEXT,
          content_json TEXT,
          raw_json TEXT,
          source_time TEXT,
          edited_at TEXT,
          evidence_ref TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(message_id,version)
        );
        CREATE TABLE IF NOT EXISTS classifications(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER NOT NULL,
          message_version INTEGER NOT NULL,
          category TEXT NOT NULL,
          confidence REAL,
          rule_id INTEGER,
          model TEXT,
          rationale TEXT,
          status TEXT NOT NULL DEFAULT 'auto',
          created_at TEXT NOT NULL,
          superseded_by INTEGER
        );
        CREATE TABLE IF NOT EXISTS rules(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 1,
          priority INTEGER NOT NULL DEFAULT 0,
          match_json TEXT,
          action_json TEXT,
          source TEXT NOT NULL DEFAULT 'seeded',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS suggestions(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER NOT NULL,
          message_version INTEGER,
          kind TEXT NOT NULL DEFAULT 'todo',
          title TEXT NOT NULL,
          summary TEXT,
          category TEXT,
          confidence REAL,
          action_json TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          rationale TEXT,
          model TEXT,
          created_at TEXT NOT NULL,
          decided_at TEXT,
          decided_device_id TEXT
        );
        CREATE TABLE IF NOT EXISTS todos(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          priority INTEGER NOT NULL DEFAULT 0,
          due_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS todo_messages(
          todo_id INTEGER NOT NULL,
          message_id INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(todo_id,message_id)
        );
        CREATE TABLE IF NOT EXISTS tasks(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          todo_id INTEGER,
          kind TEXT NOT NULL,
          executor_type TEXT NOT NULL,
          account_ref TEXT NOT NULL,
          target_ref TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'created',
          state_version INTEGER NOT NULL DEFAULT 1,
          waiting_reason TEXT,
          current_plan_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          metadata_json TEXT,
          UNIQUE(todo_id,target_ref,kind)
        );
        CREATE TABLE IF NOT EXISTS task_questions(
          task_id INTEGER NOT NULL,
          task_version INTEGER NOT NULL,
          key TEXT NOT NULL,
          label TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'text',
          options_json TEXT,
          reason TEXT,
          source_ref TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(task_id,task_version,key)
        );
        CREATE TABLE IF NOT EXISTS task_answers(
          task_id INTEGER NOT NULL,
          task_version INTEGER NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'task',
          answered_at TEXT NOT NULL,
          request_id TEXT,
          PRIMARY KEY(task_id,task_version,key)
        );
        CREATE TABLE IF NOT EXISTS document_snapshots(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          platform TEXT NOT NULL,
          document_ref TEXT NOT NULL,
          sheet_ref TEXT,
          header_json TEXT,
          identity_json TEXT,
          preconditions_json TEXT,
          captured_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS plans(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          version INTEGER NOT NULL,
          kind TEXT NOT NULL,
          document_ref TEXT NOT NULL,
          digest TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          preconditions_json TEXT,
          status TEXT NOT NULL DEFAULT 'current',
          expires_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(task_id,version)
        );
        CREATE TABLE IF NOT EXISTS approvals(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          plan_id INTEGER NOT NULL,
          plan_version INTEGER NOT NULL,
          plan_digest TEXT NOT NULL,
          decision TEXT NOT NULL,
          actor_device_id TEXT,
          client_request_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          consumed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS operations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          plan_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'queued',
          attempt INTEGER NOT NULL DEFAULT 0,
          evidence_json TEXT,
          error_class TEXT,
          started_at TEXT,
          finished_at TEXT,
          idempotency_key TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS document_locks(
          lock_key TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          task_id INTEGER,
          operation_id INTEGER,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          platform TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          token_prefix TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT 'read,write',
          paired_at TEXT NOT NULL,
          last_seen_at TEXT,
          revoked_at TEXT,
          push_subscription_json TEXT,
          last_cursor INTEGER
        );
        CREATE TABLE IF NOT EXISTS pairing_codes(
          code_hash TEXT PRIMARY KEY,
          expires_at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          consumed_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS changes(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          entity_version INTEGER,
          change_type TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          payload_json TEXT,
          run_at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          lease_owner TEXT,
          lease_expires_at TEXT,
          state TEXT NOT NULL DEFAULT 'queued',
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS command_receipts(
          client_request_id TEXT PRIMARY KEY,
          device_id TEXT,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          request_hash TEXT,
          status_code INTEGER,
          response_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings(
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_type,conversation_id,received_at DESC);
        CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status,created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_suggestions_message ON suggestions(message_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state,updated_at);
        CREATE INDEX IF NOT EXISTS idx_classifications_message ON classifications(message_id,created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_plans_task_status ON plans(task_id,status);
        CREATE INDEX IF NOT EXISTS idx_operations_state ON operations(state);
        CREATE INDEX IF NOT EXISTS idx_jobs_state_run ON jobs(state,run_at);
      `);
    }
  },
  {
    version:2,
    name:'task_request_key',
    up(db){
      // 文档链接直接派生任务，不经过 todo；request_key 用于按消息+文档去重。
      db.exec(`
        ALTER TABLE tasks ADD COLUMN request_key TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_request
          ON tasks(account_ref,request_key) WHERE request_key IS NOT NULL;
      `);
    }
  }
];

function applyMigrations(db){
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  const applied=new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row=>row.version));
  for(const migration of MIGRATIONS){
    if(applied.has(migration.version))continue;
    db.exec('BEGIN IMMEDIATE');
    try{
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
        .run(migration.version,migration.name,new Date().toISOString());
      db.exec('COMMIT');
    }catch(error){
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

module.exports={MIGRATIONS,applyMigrations,CURRENT_VERSION:MIGRATIONS[MIGRATIONS.length-1].version};
