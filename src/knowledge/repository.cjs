const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { MAX_BYTES, hash, fail, relativeName, within, checkedAbsolute, resolveSource, readFile, checkFormat, publish } = require('./files.cjs');
const profiles = require('../documents/profile.cjs');
const { createTodoKnowledge, liveAdmission } = require('./todos.cjs');

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function initialize(db) {
  transaction(db, () => db.exec(
    'CREATE TABLE IF NOT EXISTS kb_schema(version INTEGER PRIMARY KEY);' +
    'CREATE TABLE IF NOT EXISTS kb_roots(id TEXT PRIMARY KEY, owner TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, UNIQUE(owner,path));' +
    'CREATE TABLE IF NOT EXISTS kb_documents(id TEXT PRIMARY KEY, owner TEXT NOT NULL, root TEXT, name TEXT NOT NULL, rev TEXT NOT NULL, state TEXT NOT NULL);' +
    'CREATE UNIQUE INDEX IF NOT EXISTS kb_source_unique ON kb_documents(owner,root,name) WHERE state=\'active\';' +
    'CREATE TABLE IF NOT EXISTS kb_revisions(id TEXT PRIMARY KEY, doc TEXT NOT NULL, digest TEXT NOT NULL, blob TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS kb_chunks(id INTEGER PRIMARY KEY, rev TEXT NOT NULL, locator TEXT NOT NULL, body TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS kb_chunks_revision ON kb_chunks(rev);' +
    'CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(terms);' +
    'CREATE TABLE IF NOT EXISTS kb_grants(owner TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(owner,target));' +
    'CREATE TABLE IF NOT EXISTS assistant_operations(owner TEXT NOT NULL, id TEXT NOT NULL, preview TEXT NOT NULL, digest TEXT NOT NULL,' +
    ' state TEXT NOT NULL, work TEXT, result TEXT, PRIMARY KEY(owner,id), UNIQUE(owner,preview));' +
    'CREATE TABLE IF NOT EXISTS profile_deleted_fields(key TEXT PRIMARY KEY);' +
    'CREATE TABLE IF NOT EXISTS kb_todo_sources(rev TEXT PRIMARY KEY, message INTEGER NOT NULL, body TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS kb_todo_admissions(todo INTEGER NOT NULL, rev TEXT NOT NULL, PRIMARY KEY(todo,rev));' +
    'CREATE INDEX IF NOT EXISTS kb_admissions_revision ON kb_todo_admissions(rev);' +
    'INSERT OR IGNORE INTO kb_schema VALUES(1),(2);'
  ));
}

function ready(db) {
  return profiles.enabled(db);
}

function terms(body) {
  const words = body.normalize('NFKC').toLowerCase().match(/\p{Script=Han}+|[a-z0-9]+/gu) || [];
  const result = [];
  for (const word of words) {
    const chars = [...word];
    if (!/\p{Script=Han}/u.test(word) || chars.length === 1) result.push(word);
    else for (let i = 1; i < chars.length; i++) result.push(chars[i - 1] + chars[i]);
  }
  return result;
}

function chunks(segments, allowEmpty) {
  const result = [];
  // 合并同一段中的短行，保留范围定位，长页按字符边界切分。
  let group = [];
  let size = 0;
  function flush() {
    if (!group.length) return;
    const first = group[0].locator;
    const last = group.at(-1).locator;
    result.push({ locator: first === last ? first : first + '–' + last, text: group.map(row => row.text).join('\n') });
    group = [];
    size = 0;
  }
  for (const segment of segments) {
    if (!segment.text.trim()) continue;
    const wholePage = /^第 \d+ 页/.test(segment.locator);
    if (wholePage) flush();
    if (segment.text.length > 900) {
      flush();
      for (let i = 0; i < segment.text.length; i += 750) {
        result.push({ locator: segment.locator, text: segment.text.slice(i, i + 850) });
        if (i + 850 >= segment.text.length) break;
      }
    } else {
      if (size + segment.text.length > 850) flush();
      group.push(segment);
      size += segment.text.length;
    }
    if (wholePage) flush();
  }
  flush();
  if (!result.length && !allowEmpty) fail('parse_failed', 422);
  return result;
}

function parser(name, bytes, languagePath) {
  return new Promise((resolve, reject) => {
    // 解析进程只收到需要的 Buffer 和语言资源路径，不继承模型凭证。
    const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP };
    const child = fork(path.join(__dirname, 'parser-worker.cjs'), [], {
      env, execArgv: ['--max-old-space-size=256'], windowsHide: true,
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(Error('parse_timeout'), { status: 422 })); }, 60000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', () => { clearTimeout(timer); reject(Object.assign(Error('parse_failed'), { status: 422 })); });
    child.once('message', data => {
      clearTimeout(timer);
      if (data.code) reject(Object.assign(Error(data.code), { status: data.code === 'too_large' ? 413 : 422 }));
      else {
        try { resolve(chunks(data.segments, /\.(md|txt)$/i.test(name))); } catch (error) { reject(error); }
      }
    });
    child.send({ name, bytes, languagePath });
  });
}

function createKnowledge({ db, owner, storage, languagePath, trashRoot = path.join(storage, 'trash') }) {
  if (!ready(db)) fail('assistant_unavailable', 503);
  const todos = createTodoKnowledge(db, owner);
  const previews = new Map();
  let parsing = false;
  const rootById = db.prepare('SELECT * FROM kb_roots WHERE owner=? AND id=?');
  const getRoot = id => rootById.get(owner, id);
  const docById = db.prepare(
    'SELECT d.*,r.digest,r.blob FROM kb_documents d JOIN kb_revisions r ON r.id=d.rev WHERE d.owner=? AND d.id=? AND d.state=\'active\'');
  const getDoc = id => docById.get(owner, id);
  const opById = db.prepare('SELECT * FROM assistant_operations WHERE owner=? AND id=?');
  const rootList = db.prepare('SELECT id,path,kind FROM kb_roots WHERE owner=? ORDER BY path');
  const lookupSource = db.prepare('SELECT id FROM kb_documents WHERE owner=? AND root=? AND name=? AND state=\'active\'');
  const checkGrant = db.prepare('SELECT 1 FROM kb_grants WHERE owner=? AND target=?');

  function rootOrFail(id) {
    if (typeof id !== 'string') fail('invalid_input');
    const root = getRoot(id);
    if (!root) fail('outside_scope', 403);
    return root;
  }

  function documentOrFail(id) {
    if (typeof id !== 'string') fail('invalid_input');
    const doc = getDoc(id);
    if (!doc) fail('not_found', 404);
    return doc;
  }

  function blobPath(relative) {
    const parts = relativeName(relative).split('/');
    if (parts[0] === 'trash' && parts.length === 2) return path.join(trashRoot, parts[1]);
    return path.join(storage, ...parts);
  }

  function localFresh(doc) {
    if (doc.blob === '') return todos.live(doc.id);
    try {
      const blob = blobPath(doc.blob);
      if (checkedAbsolute(blob) !== blob || readFile(blob).digest !== doc.digest) return false;
      if (!doc.root) return true;
      const root = getRoot(doc.root);
      return !!root && readFile(resolveSource(root, doc.name)).digest === doc.digest;
    } catch {
      return false;
    }
  }

  function purgePreviews() {
    for (const [id, preview] of previews) if (Date.now() >= preview.expiresAt) previews.delete(id);
  }

  function summarize(document) {
    const indexed = db.prepare('SELECT 1 FROM kb_chunks WHERE rev=? LIMIT 1').get(document.rev);
    const status = localFresh(document) ? (indexed ? 'active' : 'empty') : 'stale';
    return { id: document.id, name: document.name, revision: document.rev, rootId: document.root, status, kind: document.blob === '' ? 'todo' : 'file' };
  }

  const fieldLabels = { name: '姓名', student_id: '学号', sex: '性别', age: '年龄', major: '专业', phone: '电话', email: '邮箱' };
  function profileEvidence(key) {
    if (!profiles.validKey(key)) fail('not_found', 404);
    const values = profiles.fields(db);
    if (!Object.hasOwn(values, key)) fail('not_found', 404);
    const label = Object.hasOwn(fieldLabels, key) ? fieldLabels[key] : key;
    const quote = label + ' · ' + values[key];
    return { id: 'profile-' + key, documentId: 'profile-' + key, revision: hash(quote), locator: label, quote, title: '个人资料' };
  }
  function grantLabel(target) {
    if (target.startsWith('profile-')) return profileEvidence(target.slice(8)).locator;
    if (/^todo-\d+$/.test(target)) return todos.evidence(Number(target.slice(5))).quote;
    return documentOrFail(target).name;
  }
  function indexChunks(rev, entries) {
    for (const chunk of entries) {
      const result = db.prepare('INSERT INTO kb_chunks(rev,locator,body) VALUES(?,?,?)').run(rev, chunk.locator, chunk.text);
      db.prepare('INSERT INTO kb_fts(rowid,terms) VALUES(?,?)').run(result.lastInsertRowid, terms(chunk.text).join(' '));
    }
  }

  async function makePlan(input) {
    const { kind } = input;
    if (kind === 'accept_todo' || kind === 'admit_todos') return todos.plan(input);
    if (kind === 'grant_root') {
      const root = checkedAbsolute(input.path);
      const stat = fs.statSync(root);
      if (!stat.isFile() && !stat.isDirectory()) fail('invalid_path');
      const privateRoot = path.dirname(storage);
      if (within(root, privateRoot) || within(privateRoot, root) || within(root, trashRoot) || within(trashRoot, root)) fail('outside_scope', 403);
      return { kind, id: randomUUID(), path: root, rootKind: stat.isDirectory() ? 'directory' : 'file' };
    }
    if (kind === 'cloud_grant' || kind === 'cloud_revoke') {
      const target = input.rootId || input.documentId;
      if (typeof target !== 'string') fail('invalid_input');
      const label = input.rootId ? rootOrFail(target).path : grantLabel(target);
      return { kind, target, label };
    }
    if (kind === 'remove_root') {
      const root = rootOrFail(input.rootId);
      return { kind, target: root.id, label: root.path };
    }
    if (kind === 'trash') {
      const doc = documentOrFail(input.documentId);
      if (!doc.blob) fail('outside_scope', 403);
      return { kind, document: doc.id, previous: doc.rev, blob: doc.blob, digest: doc.digest,
        name: doc.name, trashRoot, target: 'trash/' + randomUUID() + path.extname(doc.name) };
    }
    if (kind === 'profile') {
      if (!profiles.validKey(input.key) ||
          (input.value !== null && (typeof input.value !== 'string' || !input.value.trim() || input.value.length > 1000))) fail('invalid_input');
      if (input.key === 'age' && input.value !== null && !/^\d{1,3}$/.test(input.value)) fail('invalid_input');
      return { kind, key: input.key, before: profiles.fields(db)[input.key] ?? null, value: input.value };
    }
    if (kind === 'note') {
      const name = relativeName(input.name);
      if (name.includes('/') || !['.md', '.txt'].includes(path.extname(name).toLowerCase()) ||
          typeof input.text !== 'string' || Buffer.byteLength(input.text) > 1024 * 1024) fail('invalid_input');
      const previous = input.documentId ? documentOrFail(input.documentId) : null;
      if (previous && (previous.root || !previous.blob)) fail('outside_scope', 403);
      const rev = randomUUID();
      return { kind, rows: [{ id: previous?.id || randomUUID(), previous: previous?.rev ?? null, before: previous?.digest ?? null,
        beforeText: previous ? readFile(blobPath(previous.blob)).bytes.toString('utf8') : undefined,
        rev, root: null, name, body: input.text, size: Buffer.byteLength(input.text), digest: hash(input.text),
        blob: 'objects/' + rev + path.extname(name), chunks: await parser(name, Buffer.from(input.text), languagePath) }] };
    }
    if (kind !== 'import' || !Array.isArray(input.names) || input.names.length < 1 || input.names.length > 16) fail('invalid_input');
    const root = rootOrFail(input.rootId);
    const rows = [];
    const names = new Set(input.names.map(relativeName));
    let size = 0;
    for (const name of names) {
      checkFormat(name);
      const item = readFile(resolveSource(root, name));
      size += item.bytes.length;
      if (size > MAX_BYTES) fail('too_large', 413);
      const prior = lookupSource.get(owner, root.id, name);
      const previous = prior && getDoc(prior.id);
      const rev = randomUUID();
      rows.push({ id: previous?.id || randomUUID(), previous: previous?.rev ?? null, rev, root: root.id, name,
        size: item.bytes.length, digest: item.digest, blob: 'objects/' + rev + path.extname(name),
        unchanged: previous?.digest === item.digest,
        chunks: previous?.digest === item.digest ? [] : await parser(name, item.bytes, languagePath) });
    }
    return { kind, rows };
  }

  async function preview(input) {
    purgePreviews();
    if (parsing || previews.size >= 8) fail('busy', 429);
    parsing = true;
    try {
      const plan = await makePlan(input);
      const serialized = JSON.stringify(plan);
      const held = [...previews.values()].reduce((total, preview) => total + Buffer.byteLength(preview.serialized), 0);
      if (held + Buffer.byteLength(serialized) > MAX_BYTES) fail('too_large', 413);
      const id = randomUUID();
      const receipt = { id, digest: hash(serialized), expiresAt: Date.now() + 15 * 60000, serialized, plan };
      previews.set(id, receipt);
      return review(receipt);
    } finally {
      parsing = false;
    }
  }

  function review(receipt) {
    const { id, digest, expiresAt, plan } = receipt;
    let details = plan;
    if (plan.rows) {
      details = { kind: plan.kind, rows: plan.rows.map(row => ({
        name: row.name, sha256: row.digest, bytes: row.size, chunks: row.chunks.length, unchanged: !!row.unchanged,
        target: blobPath(row.blob), before: row.beforeText,
        text: plan.kind === 'note' ? row.body : undefined
      })) };
    } else if (plan.kind === 'trash') {
      details = { ...plan, target: blobPath(plan.target), blob: blobPath(plan.blob) };
    }
    return { id, digest, expiresAt, details };
  }

  function precheck(plan) {
    if (checkedAbsolute(storage) !== storage) fail('outside_scope', 403);
    if (plan.kind === 'grant_root' && checkedAbsolute(plan.path) !== plan.path) fail('preview_changed', 409);
    if (plan.kind === 'cloud_grant' && !getRoot(plan.target)) grantLabel(plan.target);
    if (plan.kind === 'accept_todo' || plan.kind === 'admit_todos') todos.check(plan);
    if (plan.rows) {
      const verified = [];
      for (const row of plan.rows) {
        const previous = getDoc(row.id);
        if ((previous?.rev ?? null) !== row.previous) fail('preview_changed', 409);
        if (row.root && (lookupSource.get(owner, row.root, row.name)?.id ?? null) !== (previous?.id ?? null)) fail('preview_changed', 409);
        if (!row.root && previous && !localFresh(previous)) fail('preview_changed', 409);
        const source = row.root ? readFile(resolveSource(rootOrFail(row.root), row.name)) : { bytes: Buffer.from(row.body), digest: hash(row.body) };
        if (source.digest !== row.digest) fail('preview_changed', 409);
        verified.push(source.bytes);
      }
      return verified;
    }
    if (plan.kind === 'trash') {
      const doc = documentOrFail(plan.document);
      if (doc.rev !== plan.previous || doc.digest !== plan.digest) fail('preview_changed', 409);
      if (plan.trashRoot !== trashRoot || checkedAbsolute(trashRoot) !== trashRoot) fail('preview_changed', 409);
      const source = blobPath(plan.blob);
      const target = blobPath(plan.target);
      const location = fs.existsSync(source) ? source : target;
      if (checkedAbsolute(location) !== location || readFile(location).digest !== plan.digest) fail('preview_changed', 409);
    }
    if (plan.kind === 'profile') {
      if ((profiles.fields(db)[plan.key] ?? null) !== plan.before) fail('preview_changed', 409);
    }
    return [];
  }

  function applyPlan(plan, opId) {
    const bytes = precheck(plan);
    if (plan.rows) {
      for (const [index, row] of plan.rows.entries()) {
        if (row.unchanged) continue;
        const target = blobPath(row.blob);
        if (checkedAbsolute(path.dirname(target)) !== path.dirname(target)) fail('outside_scope', 403);
        publish(target, bytes[index], row.digest);
      }
    }
    if (plan.kind === 'trash') {
      const source = blobPath(plan.blob);
      const target = blobPath(plan.target);
      if (checkedAbsolute(path.dirname(target)) !== path.dirname(target)) fail('outside_scope', 403);
      if (fs.existsSync(source)) {
        const payload = readFile(source);
        if (payload.digest !== plan.digest) fail('preview_changed', 409);
        publish(target, payload.bytes, plan.digest);
        if (readFile(source).digest !== plan.digest) fail('preview_changed', 409);
        fs.unlinkSync(source);
      }
    }
    return transaction(db, () => {
      let result = { id: opId, state: 'committed', kind: plan.kind };
      if (plan.kind === 'accept_todo' || plan.kind === 'admit_todos') {
        Object.assign(result, todos.apply(plan, (rev, text, locator) => indexChunks(rev, chunks([{ text, locator }], false))));
      } else if (plan.kind === 'grant_root') {
        db.prepare('INSERT OR IGNORE INTO kb_roots VALUES(?,?,?,?)').run(plan.id, owner, plan.path, plan.rootKind);
        result.rootId = db.prepare('SELECT id FROM kb_roots WHERE owner=? AND path=?').get(owner, plan.path).id;
      } else if (plan.kind === 'remove_root') {
        db.prepare('DELETE FROM kb_roots WHERE owner=? AND id=?').run(owner, plan.target);
        db.prepare('DELETE FROM kb_grants WHERE owner=? AND target=?').run(owner, plan.target);
      } else if (plan.kind === 'cloud_grant') {
        db.prepare('INSERT OR IGNORE INTO kb_grants VALUES(?,?)').run(owner, plan.target);
      } else if (plan.kind === 'cloud_revoke') {
        db.prepare('DELETE FROM kb_grants WHERE owner=? AND target=?').run(owner, plan.target);
      } else if (plan.kind === 'profile') {
        if ((profiles.fields(db)[plan.key] ?? null) !== plan.before) fail('preview_changed', 409);
        profiles.setField(db, plan.key, plan.value, 'assistant');
      } else if (plan.kind === 'trash') {
        db.prepare("UPDATE kb_documents SET state='trash' WHERE owner=? AND id=?").run(owner, plan.document);
        result.target = blobPath(plan.target);
      } else {
        result.imported = 0;
        result.unchanged = 0;
        for (const row of plan.rows) {
          if (row.unchanged) { result.unchanged++; continue; }
          db.prepare('INSERT INTO kb_revisions VALUES(?,?,?,?)').run(row.rev, row.id, row.digest, row.blob);
          if (row.previous) db.prepare('UPDATE kb_documents SET rev=?,name=? WHERE owner=? AND id=?').run(row.rev, row.name, owner, row.id);
          else db.prepare("INSERT INTO kb_documents VALUES(?,?,?,?,?,'active')").run(row.id, owner, row.root, row.name, row.rev);
          indexChunks(row.rev, row.chunks);
          result.imported++;
        }
      }
      db.prepare("UPDATE assistant_operations SET state='committed',work=NULL,result=? WHERE owner=? AND id=?")
        .run(JSON.stringify(result), owner, opId);
      return result;
    });
  }

  function executeApproved(plan, id) {
    try {
      return applyPlan(plan, id);
    } catch (error) {
      const state = error.status === 409 || error.status === 403 ? 'conflict' : 'outcome_unknown';
      const result = { id, state, code: error.status ? error.message : 'write_failed' };
      db.prepare('UPDATE assistant_operations SET state=?,result=? WHERE owner=? AND id=?')
        .run(state, JSON.stringify(result), owner, id);
      return result;
    }
  }

  function decide(previewId, input) {
    const { clientRequestId: id, digest, decision } = input;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(id) || !['approve', 'reject'].includes(decision)) fail('invalid_input');
    const existing = opById.get(owner, id);
    if (existing) {
      if (existing.digest !== digest || existing.preview !== previewId || decision !== 'approve') fail('idempotency_conflict', 409);
      return existing.result ? JSON.parse(existing.result) : { id, state: existing.state };
    }
    purgePreviews();
    const receipt = previews.get(previewId);
    if (!receipt) fail('not_found', 404);
    if (receipt.digest !== digest) fail('preview_changed', 409);
    if (decision === 'reject') {
      previews.delete(previewId);
      return { state: 'rejected' };
    }
    precheck(receipt.plan);
    db.prepare("INSERT INTO assistant_operations VALUES(?,?,?,?,'approved',?,NULL)")
      .run(owner, id, previewId, digest, receipt.serialized);
    previews.delete(previewId);
    return executeApproved(receipt.plan, id);
  }

  function evidence(row) {
    const doc = getDoc(row.doc);
    if (!doc || doc.rev !== row.rev || !localFresh(doc)) return null;
    return { id: String(row.id), documentId: row.doc, revision: row.rev, locator: row.locator, quote: row.body, title: doc.name };
  }

  const evidenceQuery = db.prepare('SELECT c.*,d.id AS doc FROM kb_chunks c JOIN kb_documents d ON d.rev=c.rev WHERE d.owner=? AND c.id=?');
  function getEvidence(id) {
    if (/^todo-\d+$/.test(id)) return todos.evidence(Number(id.slice(5)));
    if (typeof id === 'string' && id.startsWith('profile-')) return profileEvidence(id.slice(8));
    if (!/^\d+$/.test(String(id))) fail('not_found', 404);
    const row = evidenceQuery.get(owner, Number(id));
    const item = row && evidence(row);
    if (!item) fail('not_found', 404);
    return item;
  }

  function search(query, selected) {
    if (!selected?.length && /待办|\btodos?\b/i.test(query)) {
      const titles = todos.list().map(item => todos.evidence(item.id));
      return [...titles, ...todos.sourceChunks().map(evidence).filter(Boolean).slice(0, 8)];
    }
    if (!selected?.length) {
      const personal = Object.keys(profiles.fields(db)).filter(key => {
        const label = Object.hasOwn(fieldLabels, key) ? fieldLabels[key] : key;
        if (query.trim().toLowerCase() === key.toLowerCase() || query.trim() === label) return true;
        return /我|个人资料|档案/.test(query) && (query.includes(label) || /个人资料|档案/.test(query));
      }).slice(0, 20);
      if (personal.length) return personal.map(profileEvidence);
    }
    const cleaned = query.replace(/请问|帮我|告诉我|解释一下|请解释|是什么|有哪些|怎么|如何|介绍一下|请|一下|吗|什么|请介绍/g, ' ');
    const keywords = [...new Set(terms(cleaned))].filter(term => !['what','is','the','a','an','how','can','i','do','please','explain'].includes(term)).slice(0, 32);
    if (!keywords.length) return [];
    const found = db.prepare(
      "SELECT c.*,d.id AS doc FROM kb_fts JOIN kb_chunks c ON c.id=kb_fts.rowid JOIN kb_documents d ON d.rev=c.rev " +
      "JOIN kb_revisions r ON r.id=d.rev WHERE kb_fts MATCH ? AND d.owner=? AND d.state='active' AND (r.blob<>'' OR " +
      liveAdmission + ") ORDER BY bm25(kb_fts),c.id LIMIT 96"
    ).all(keywords.map(term => '"' + term + '"').join(' OR '), owner);
    const result = [];
    const counts = new Map();
    for (const row of found) {
      if (selected?.length && !selected.includes(row.doc)) continue;
      if ((counts.get(row.doc) || 0) >= 3) continue;
      const present = new Set(terms(row.body));
      const matches = keywords.filter(term => present.has(term));
      if (keywords.length >= 4 && matches.length < 2) continue;
      const item = evidence(row);
      if (!item) continue;
      result.push(item);
      counts.set(row.doc, (counts.get(row.doc) || 0) + 1);
      if (result.length === 8) break;
    }
    return result;
  }

  function cloudAllowed(item) {
    if (/^(todo-\d+|profile-)/.test(item.id)) {
      try { return !!checkGrant.get(owner, item.documentId) && getEvidence(item.id).revision === item.revision; }
      catch { return false; }
    }
    const doc = getDoc(item.documentId);
    return !!doc && doc.rev === item.revision && localFresh(doc) &&
      (!!checkGrant.get(owner, doc.id) || (!!doc.root && !!checkGrant.get(owner, doc.root)));
  }

  function entries(id, directory = '', offset = 0) {
    const root = rootOrFail(id);
    const target = directory ? resolveSource(root, directory) : checkedAbsolute(root.path);
    const rows = root.kind === 'file' ? [{ name: path.basename(root.path), directory: false }] :
      fs.readdirSync(target, { withFileTypes: true })
        .filter(entry => !entry.isSymbolicLink() && !entry.name.startsWith('.') && (entry.isDirectory() || entry.isFile()))
        .map(entry => ({ name: directory ? directory + '/' + entry.name : entry.name, directory: entry.isDirectory() }));
    rows.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh'));
    return { items: rows.slice(offset, offset + 200), next: rows.length > offset + 200 ? offset + 200 : null };
  }

  for (const pending of db.prepare("SELECT * FROM assistant_operations WHERE owner=? AND state='approved'").all(owner)) {
    if (pending.work && hash(pending.work) === pending.digest) executeApproved(JSON.parse(pending.work), pending.id);
  }

  return {
    preview, decide, search, getEvidence, cloudAllowed, entries,
    todos: todos.list,
    profile: () => Object.entries(profiles.fields(db)).map(([key, value]) => ({ key, value })),
    getPreview(id) { purgePreviews(); const receipt = previews.get(id); if (!receipt) fail('not_found', 404); return review(receipt); },
    roots: () => rootList.all(owner),
    documents(offset = 0) {
      return db.prepare("SELECT d.*,r.digest,r.blob FROM kb_documents d JOIN kb_revisions r ON r.id=d.rev WHERE d.owner=? AND d.state='active' AND (r.blob<>'' OR " +
        liveAdmission + ") ORDER BY d.name LIMIT 101 OFFSET ?")
        .all(owner, offset).slice(0, 100).map(summarize);
    },
    document(id) {
      const doc = documentOrFail(id);
      const data = summarize(doc);
      if (!doc.root && doc.blob && data.status !== 'stale') data.text = readFile(blobPath(doc.blob)).bytes.toString('utf8');
      return data;
    },
    grants: () => db.prepare('SELECT target FROM kb_grants WHERE owner=? ORDER BY target').all(owner),
    operation(id) {
      const row = opById.get(owner, id);
      if (!row) fail('not_found', 404);
      return row.result ? JSON.parse(row.result) : { id, state: row.state };
    }
  };
}

module.exports = { initialize, ready, createKnowledge };
