// 导入本地笔记。plan 只读取并输出摘要，apply 只接受匹配的清单摘要。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig } = require('../src/config.cjs');
const { backupDatabase } = require('../src/db/backup.cjs');
const { readAssistantConfig } = require('../src/assistant/api.cjs');
const { resolveWorkspace } = require('../src/workspace/context.cjs');
const { initialize, ready, createKnowledge } = require('../src/knowledge/repository.cjs');
const { checkedAbsolute, readFile, resolveSource, relativeName, hash, within } = require('../src/knowledge/files.cjs');

function inventory(source, excluded) {
  const entries = [];
  const root = { path: checkedAbsolute(source), kind: 'directory' };
  const textFiles = new Set(['.md', '.txt', '.pdf', '.docx']);
  function walk(current) {
    const location = current ? resolveSource(root, current) : root.path;
    for (const entry of fs.readdirSync(location, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const name = relativeName(current ? current + '/' + entry.name : entry.name);
      if (name.toLowerCase() === excluded.toLowerCase()) continue;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && textFiles.has(path.extname(name).toLowerCase())) {
        const { bytes, digest } = readFile(resolveSource(root, name));
        entries.push({ name, digest, bytes: bytes.length });
      }
    }
  }
  walk('');
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { source: root.path, excluded, entries };
}

async function main() {
  const [action, source, exclude, accepted] = process.argv.slice(2);
  if (!source || !exclude || !['plan', 'apply'].includes(action)) {
    throw Error('usage: node tools/import-notes.cjs plan|apply <source> <excluded-subtree> [digest]');
  }
  const manifest = inventory(source, relativeName(exclude));
  const digest = hash(JSON.stringify(manifest));
  const summary = { count: manifest.entries.length, bytes: manifest.entries.reduce((total, entry) => total + entry.bytes, 0), digest };
  if (action === 'plan') {
    console.log(JSON.stringify(summary));
    return;
  }
  if (!manifest.entries.length || accepted !== digest) throw Error('manifest_changed');
  if (process.version !== 'v24.22.2') throw Error('verified_node_required');
  const privateRoot = checkedAbsolute(path.resolve('.private'));
  if (within(privateRoot, manifest.source) || within(manifest.source, privateRoot)) throw Error('outside_scope');
  loadConfig(path.join(privateRoot, 'config.json'), { allowUnconfigured: true });
  const dbPath = checkedAbsolute(path.join(privateRoot, 'poc.sqlite'));
  const db = new DatabaseSync(dbPath);
  try {
    const workspace = resolveWorkspace(db);
    if (!workspace) throw Error('workspace_not_initialized');
    if (db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version !== 9) throw Error('unexpected_baseline_schema');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('database_integrity_failed');
    if (!ready(db)) {
      const backupDir = path.join(privateRoot, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      if (checkedAbsolute(backupDir) !== backupDir) throw Error('invalid_backup_root');
      const receipt = backupDatabase(dbPath, path.join(backupDir, 'before-m1-' + randomUUID() + '.sqlite'));
      if (receipt.integrity !== 'ok') throw Error('backup_integrity_failed');
      initialize(db);
    }
    const storage = path.join(privateRoot, 'kb');
    for (const dir of ['objects', 'trash']) {
      const target = path.join(storage, dir);
      fs.mkdirSync(target, { recursive: true });
      if (checkedAbsolute(target) !== target) throw Error('invalid_storage_root');
    }
    const configFile = path.join(privateRoot, 'assistant.config.json');
    const settings = readAssistantConfig(configFile);
    const trashRoot = settings?.trashRoot ? checkedAbsolute(settings.trashRoot) : undefined;
    const knowledge = createKnowledge({ db, owner: workspace.id, workspace, storage, trashRoot, languagePath: path.join(privateRoot, 'ocr') });
    function confirm(preview) {
      const result = knowledge.decide(preview.id, { decision: 'approve', digest: preview.digest, clientRequestId: randomUUID() });
      if (result.state !== 'committed') throw Error(result.code || 'migration_conflict');
      return result;
    }
    const root = knowledge.roots().find(item => item.path === manifest.source) ||
      { id: confirm(await knowledge.preview({ kind: 'grant_root', path: manifest.source })).rootId };
    let imported = 0;
    let unchanged = 0;
    for (let start = 0; start < manifest.entries.length; start += 16) {
      const batch = manifest.entries.slice(start, start + 16);
      const preview = await knowledge.preview({ kind: 'import', rootId: root.id, names: batch.map(item => item.name) });
      if (preview.details.rows.length !== batch.length || preview.details.rows.some(row => {
        const approved = batch.find(entry => entry.name === row.name);
        return !approved || row.sha256 !== approved.digest;
      })) throw Error('manifest_changed');
      const result = confirm(preview);
      imported += result.imported;
      unchanged += result.unchanged;
    }
    const lookup = db.prepare("SELECT r.blob,r.digest,(SELECT count(*) FROM kb_chunks c JOIN kb_fts f ON f.rowid=c.id WHERE c.rev=r.id) AS chunks FROM kb_documents d JOIN kb_revisions r ON r.id=d.rev WHERE d.owner=? AND d.root=? AND d.name=? AND d.state='active'");
    let totalChunks = 0;
    let emptyDocuments = 0;
    for (const item of manifest.entries) {
      const active = lookup.get(workspace.id, root.id, item.name);
      if (!active || active.digest !== item.digest) throw Error('migration_verification_failed');
      const copy = readFile(path.join(storage, ...relativeName(active.blob).split('/')));
      if (copy.digest !== item.digest) throw Error('migration_verification_failed');
      if (!active.chunks) {
        if (!/\.(md|txt)$/i.test(item.name) || copy.bytes.toString('utf8').trim()) throw Error('migration_verification_failed');
        emptyDocuments++;
      }
      totalChunks += active.chunks;
    }
    if (hash(JSON.stringify(inventory(source, relativeName(exclude)))) !== digest) throw Error('manifest_changed');
    if (!fs.existsSync(configFile)) {
      fs.writeFileSync(configFile, JSON.stringify({
        enabled: true, desktop_token_env: 'CAMPUS_DESK_ASSISTANT_TOKEN',
        models: [{ id: 'deepseek', label: 'DeepSeek', adapter: 'chat-completions', base_url: 'https://api.deepseek.com',
          model: 'deepseek-chat', credential_env: 'DEEPSEEK_API_KEY', output_limit_tokens: 1024, timeout_ms: 30000 }]
      }, null, 2), { flag: 'wx' });
    }
    const result = { ...summary, imported, unchanged, verified: manifest.entries.length, emptyDocuments, totalChunks,
      cloudGrants: knowledge.grants().length };
    fs.writeFileSync(path.join(storage, 'migration-' + randomUUID() + '.json'), JSON.stringify({ ...result, manifest }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(result));
  } finally {
    db.close();
  }
}

main().catch(error => {
  const message = String(error.message);
  console.error(/^[a-z_]+$/.test(message) || message.startsWith('usage:') ? message : 'local_migration_failed');
  process.exitCode = 1;
});
