const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');

test('migrations: create v2 tables idempotently and keep legacy tables usable',()=>{
  const store=openStore(':memory:');
  applyMigrations(store.db);
  applyMigrations(store.db);
  const tables=new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
  for(const name of ['schema_migrations','messages','message_versions','sources','suggestions','todos','tasks','plans','approvals','operations','devices','changes','jobs','settings']){
    assert.equal(tables.has(name),true,`missing table ${name}`);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,1);
  store.saveProfile({name:'测试甲',student_id:'00123',sex:'男',age:19});
  assert.equal(store.profile().student_id,'00123');
  assert.equal(store.enqueue('source:1','https://docs.qq.com/sheet/abc'),true);
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
