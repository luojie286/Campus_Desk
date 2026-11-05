// 在主机停止时运行。为 V1 知识库创建一致性备份后，再登记 M2 表。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig } = require('../src/config.cjs');
const { backupDatabase } = require('../src/db/backup.cjs');
const { initialize, ready } = require('../src/knowledge/repository.cjs');
const { checkedAbsolute } = require('../src/knowledge/files.cjs');

function checkStopped(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); reject(Error('host_running')); });
    socket.once('timeout', () => { socket.destroy(); reject(Error('host_status_unknown')); });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(Error('host_status_unknown'));
    });
  });
}

async function main() {
  if (process.version !== 'v24.22.2') throw Error('verified_node_required');
  const privateRoot = checkedAbsolute(path.resolve('.private'));
  const config = loadConfig(path.join(privateRoot, 'config.json'), { allowUnconfigured: true });
  await checkStopped(config.port);
  const dbPath = checkedAbsolute(path.join(privateRoot, 'poc.sqlite'));
  const db = new DatabaseSync(dbPath);
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('database_integrity_failed');
    if (ready(db)) {
      console.log(JSON.stringify({ version: 2, upgraded: false }));
      return;
    }
    if (db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version !== 9 ||
        !db.prepare('SELECT version FROM kb_schema WHERE version=1').get()) throw Error('unexpected_schema');
    const backups = path.join(privateRoot, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    if (checkedAbsolute(backups) !== backups) throw Error('invalid_backup_root');
    const manifest = backupDatabase(dbPath, path.join(backups, 'before-m2-' + randomUUID() + '.sqlite'));
    initialize(db);
    if (!ready(db) || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('migration_verification_failed');
    console.log(JSON.stringify({ version: 2, upgraded: true, backupIntegrity: manifest.integrity }));
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(/^[a-z_]+$/.test(error.message) ? error.message : 'assistant_upgrade_failed');
  process.exitCode = 1;
});
