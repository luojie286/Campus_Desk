// 只为全新工作区创建现有 Node 适配器所需的兼容表。
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { openStore } = require('../src/core.cjs');
const { applyMigrations } = require('../src/db/migrate.cjs');
const { initialize } = require('../src/knowledge/repository.cjs');
const { checkedAbsolute } = require('../src/knowledge/files.cjs');
const path = require('node:path');

function main() {
  if (process.version !== 'v24.22.2') throw Error('verified_node_required');
  const port = Number(process.argv[2] ?? 9087);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('port_invalid');
  if (fs.existsSync('.private/poc.sqlite') || fs.existsSync('.private/config.json')) throw Error('existing_host_requires_migration');
  fs.mkdirSync('.private', { recursive: true });
  if (path.relative(checkedAbsolute(path.resolve('.private')), path.resolve('.private'))) throw Error('outside_scope');
  fs.writeFileSync('.private/config.json', JSON.stringify({
    port, token: randomBytes(32).toString('hex'), source: { type: 'private', id: '' },
    pipeline: 'v2', messageCenter: true, execute: false, allowed_document: ''
  }, null, 2), { flag: 'wx' });
  const store = openStore('.private/poc.sqlite');
  try {
    applyMigrations(store.db);
    initialize(store.db);
  } finally {
    store.db.close();
  }
  for (const dir of ['objects', 'trash']) fs.mkdirSync('.private/kb/' + dir, { recursive: true });
  if (!fs.existsSync('.private/assistant.config.json')) {
    fs.writeFileSync('.private/assistant.config.json', JSON.stringify({
      enabled: true, desktop_token_env: 'CAMPUS_DESK_ASSISTANT_TOKEN', models: []
    }, null, 2), { flag: 'wx' });
  }
}

try { main(); } catch (error) {
  console.error(/^[a-z_]+$/.test(error.message) ? error.message : 'workspace_bootstrap_failed');
  process.exitCode = 1;
}
