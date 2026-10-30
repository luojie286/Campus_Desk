const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/core.cjs');
const {applyMigrations,CURRENT_VERSION,MIGRATIONS}=require('../src/db/migrate.cjs');

test('migrations: create v2 tables idempotently and keep legacy tables usable',()=>{
  const store=openStore(':memory:');
  applyMigrations(store.db);
  applyMigrations(store.db);
  const tables=new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
  for(const name of ['schema_migrations','messages','message_versions','sources','suggestions','suggestion_messages','conversation_cursors','todos','tasks','plans','approvals','operations','devices','changes','jobs','settings']){
    assert.equal(tables.has(name),true,`missing table ${name}`);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,CURRENT_VERSION);
  const taskColumns=store.db.prepare('PRAGMA table_info(tasks)').all().map(column=>column.name);
  assert.equal(taskColumns.includes('request_key'),true);
  const suggestionColumns=store.db.prepare('PRAGMA table_info(suggestions)').all().map(column=>column.name);
  for(const column of ['account_ref','conversation_type','conversation_id','thread_key','source_count','updated_at']){
    assert.equal(suggestionColumns.includes(column),true,`missing suggestion column ${column}`);
  }
  const jobColumns=store.db.prepare('PRAGMA table_info(jobs)').all().map(column=>column.name);
  assert.equal(jobColumns.includes('dedupe_key'),true);
  store.saveProfile({name:'测试甲',student_id:'00123',sex:'男',age:19});
  assert.equal(store.profile().student_id,'00123');
  assert.equal(store.enqueue('source:1','https://docs.qq.com/sheet/abc'),true);
  store.db.close();
});
test('migrations: bootstrap conversation cursors to existing messages',()=>{
  const store=openStore(':memory:');
  applyMigrations(store.db);
  const now=new Date().toISOString();
  store.db.prepare(`INSERT INTO messages
    (platform,adapter_instance,account_ref,conversation_type,conversation_id,sender_id,source_message_id,received_at,created_at,updated_at)
    VALUES('qq','a','7007','group','6318','1278','m1',?,?,?)`).run(now,now,now);
  const insert=store.db.prepare(`INSERT INTO messages
    (platform,adapter_instance,account_ref,conversation_type,conversation_id,sender_id,source_message_id,received_at,created_at,updated_at)
    VALUES('qq','a','7007','group','6318','1278','m2',?,?,?)`);
  insert.run(now,now,now);
  const lastId=store.db.prepare("SELECT MAX(id) AS id FROM messages").get().id;
  MIGRATIONS.find(migration=>migration.version===5).up(store.db);
  const cursor=store.db.prepare("SELECT last_message_id FROM conversation_cursors WHERE account_ref='7007' AND conversation_type='group' AND conversation_id='6318'").get();
  assert.equal(cursor.last_message_id,lastId);
  store.db.close();
});
test('migrations: message composite uniqueness and settings round-trip',()=>{
  const store=openStore(':memory:');
  applyMigrations(store.db);
  const now=new Date().toISOString();
  const insert=store.db.prepare(`INSERT OR IGNORE INTO messages
    (platform,adapter_instance,account_ref,conversation_type,conversation_id,sender_id,source_message_id,received_at,created_at,updated_at)
    VALUES('qq','a','7007','group','6318','1278','m1',?,?,?)`);
  assert.equal(insert.run(now,now,now).changes,1);
  assert.equal(insert.run(now,now,now).changes,0);
  store.db.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES('retention_days','90',?)").run(now);
  assert.equal(store.db.prepare("SELECT value_json FROM settings WHERE key='retention_days'").get().value_json,'90');
  store.db.close();
});
