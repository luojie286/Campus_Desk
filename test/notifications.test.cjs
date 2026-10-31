const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createNotificationRepository}=require('../src/db/repositories/notifications.cjs');

const now='2026-10-31T00:00:00.000Z';
test('notifications: insert, list unread and mark read per account',()=>{
  const store=openStore(':memory:');
  applyMigrations(store.db);
  const notifications=createNotificationRepository(store.db);
  const id=notifications.insert({accountRef:'7007',kind:'attachment_ignored',title:'附件格式不支持',body:'a.zip',createdAt:now});
  assert.equal(notifications.unreadCount({accountRef:'7007'}),1);
  assert.equal(notifications.list({accountRef:'7007',unreadOnly:true}).length,1);
  assert.equal(notifications.list({accountRef:'9999'}).length,0);
  assert.equal(notifications.markRead({id,accountRef:'9999'}),false);
  assert.equal(notifications.markRead({id,accountRef:'7007',readAt:now}),true);
  assert.equal(notifications.unreadCount({accountRef:'7007'}),0);
  store.db.close();
});
