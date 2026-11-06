const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openStore } = require('../src/core.cjs');
const { applyMigrations } = require('../src/db/migrate.cjs');
const { createSourceRepository } = require('../src/db/repositories/sources.cjs');
const { createMessageRepository } = require('../src/db/repositories/messages.cjs');
const { createJobRepository } = require('../src/db/repositories/jobs.cjs');
const { createMessageService } = require('../src/messages/service.cjs');

test('R2: failing to enqueue rolls back the receipt and source message before a retry', async t => {
  const store = openStore(':memory:');
  t.after(() => store.db.close());
  applyMigrations(store.db);
  const accountRef = '9991';
  const sources = createSourceRepository(store.db);
  const source = sources.add({ accountRef, conversationType: 'private', conversationId: '7316' });
  const messages = createMessageRepository(store.db);
  const jobs = createJobRepository(store.db);
  const config = { account_id: accountRef, messageCenter: true, pipeline: 'v2' };
  const base = { store, config, sources, messages, select: async () => ({ source_id: source.id }) };
  const event = { post_type: 'message', message_type: 'private', self_id: accountRef, user_id: '7316', message_id: 'event-a', message: '合成消息' };
  const failing = createMessageService({ ...base, jobs: { enqueue() { throw Error('simulated_enqueue_failure'); } } });
  await assert.rejects(failing.ingestMessage(event), /simulated_enqueue_failure/);
  for (const table of ['inbound_events','messages','message_versions','jobs']) {
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM '+table).get().n, 0);
  }
  const ready = createMessageService({ ...base, jobs });
  const result = await ready.ingestMessage(event);
  assert.ok(result.stored);
  assert.equal((await ready.ingestMessage(event)).duplicate, true);
  for (const table of ['inbound_events','messages','message_versions','jobs']) {
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM '+table).get().n, 1);
  }
});
