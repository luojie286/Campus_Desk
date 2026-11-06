const { createSuggestionRepository } = require('../db/repositories/suggestions.cjs');
const { fail, hash } = require('./files.cjs');
const { historyPredicate } = require('../workspace/context.cjs');

function createTodoKnowledge(db, owner, workspace) {
  const suggestions = createSuggestionRepository(db);
  const canRead = (alias, boundOwner) => workspace ? historyPredicate(alias, boundOwner) : alias + '.account_ref=' + boundOwner;
  const sameAccount = "NOT EXISTS(SELECT 1 FROM todo_messages other JOIN messages om ON om.id=other.message_id " +
    "WHERE other.todo_id=t.id AND (om.account_ref<>m.account_ref OR om.platform<>m.platform))";
  const liveAdmission = "EXISTS (SELECT 1 FROM kb_todo_sources s JOIN kb_todo_admissions a ON a.rev=s.rev " +
    "JOIN todo_messages tm ON tm.todo_id=a.todo AND tm.message_id=s.message " +
    "JOIN todos t ON t.id=tm.todo_id JOIN messages m ON m.id=tm.message_id " +
    "WHERE s.rev=d.rev AND t.status='open' AND m.content_text IS s.body AND " + canRead('m','d.owner') + ' AND ' + sameAccount + ')';
  function current(id) {
    const todo = db.prepare("SELECT t.* FROM todos t JOIN todo_messages tm ON tm.todo_id=t.id JOIN messages m ON m.id=tm.message_id " +
      "WHERE t.id=? AND t.status='open' AND " + canRead('m','?') + ' AND ' + sameAccount + ' LIMIT 1')
      .get(id, owner);
    if (!todo) fail('todo_unavailable', 409);
    return todo;
  }
  function sourceSnapshot(id, candidate) {
    let title, rows, candidateAccount;
    if (candidate) {
      const item = db.prepare("SELECT s.*,m.account_ref AS source_account,m.platform AS source_platform FROM suggestions s JOIN messages m ON m.id=s.message_id " +
        "WHERE s.id=? AND s.status='pending' AND s.kind='todo' AND " + canRead('m','?'))
        .get(id, owner);
      if (!item) fail('todo_unavailable', 409);
      title = item.title;
      candidateAccount = item.source_account;
      rows = db.prepare("SELECT m.id,m.account_ref,m.platform,m.content_text FROM messages m WHERE m.id=? OR m.id IN " +
        "(SELECT message_id FROM suggestion_messages WHERE suggestion_id=?) ORDER BY m.id").all(item.message_id, id);
      if (rows.some(row => row.account_ref !== candidateAccount || row.platform !== item.source_platform)) fail('outside_scope', 403);
    } else {
      const item = current(id);
      title = item.title;
      rows = db.prepare('SELECT m.id,m.account_ref,m.content_text FROM todo_messages tm JOIN messages m ON m.id=tm.message_id WHERE tm.todo_id=? ORDER BY m.id').all(id);
    }
    if (!rows.length) fail('outside_scope', 403);
    if (rows.length > 32 || rows.some(row => Buffer.byteLength(row.content_text || '') > 256 * 1024)) fail('too_large', 413);
    return { id, title, candidateAccount, messages: rows.map(row => ({ id: row.id, text: row.content_text })) };
  }
  function plan(input) {
    const candidate = input.kind === 'accept_todo';
    const ids = candidate ? [input.suggestionId] : input.todoIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 16 ||
        ids.some(id => !Number.isSafeInteger(id) || id < 1)) fail('invalid_input');
    return { kind: input.kind, items: [...new Set(ids)].map(id => sourceSnapshot(id, candidate)) };
  }
  function check(pending) {
    const snapshot = plan({ kind: pending.kind, suggestionId: pending.items[0].id, todoIds: pending.items.map(item => item.id) });
    if (JSON.stringify(snapshot) !== JSON.stringify(pending)) fail('preview_changed', 409);
  }
  function apply(pending, index) {
    check(pending);
    const todoIds = [];
    let admitted = 0;
    for (const item of pending.items) {
      const id = pending.kind === 'accept_todo' ? suggestions.accept({ id: item.id, accountRef: item.candidateAccount }).todo.id : item.id;
      todoIds.push(id);
      for (const message of item.messages) {
        if (!message.text?.trim()) continue;
        // 旧账号迁移时保留原资料 ID；重复纳入或源正文换版均复用同一资料。
        const existing = db.prepare('SELECT d.id FROM kb_documents d JOIN kb_todo_sources s ON s.rev=d.rev WHERE d.owner=? AND s.message=?')
          .get(owner, message.id);
        const doc = existing?.id ?? hash(JSON.stringify([owner, 'todo-source', message.id]));
        const rev = hash(JSON.stringify([doc, message.text]));
        if (!db.prepare('SELECT 1 FROM kb_revisions WHERE id=?').get(rev)) {
          db.prepare("INSERT INTO kb_revisions VALUES(?,?,?,'')").run(rev, doc, hash(message.text));
          db.prepare('INSERT INTO kb_todo_sources VALUES(?,?,?)').run(rev, message.id, message.text);
          index(rev, message.text, '来源消息 #' + message.id);
        }
        db.prepare("INSERT INTO kb_documents VALUES(?,?,NULL,?,?,'active') ON CONFLICT(id) DO UPDATE SET rev=excluded.rev")
          .run(doc, owner, '待办来源 #' + message.id, rev);
        admitted += db.prepare('INSERT OR IGNORE INTO kb_todo_admissions VALUES(?,?)').run(id, rev).changes;
      }
    }
    return { todoIds, admitted };
  }
  function list() {
    return db.prepare("SELECT t.id,t.title,t.due_at,COUNT(DISTINCT a.rev) AS admitted " +
      "FROM todos t JOIN todo_messages tm ON tm.todo_id=t.id JOIN messages m ON m.id=tm.message_id " +
      "LEFT JOIN kb_todo_admissions a ON a.todo=t.id AND EXISTS (SELECT 1 FROM kb_todo_sources s JOIN kb_documents d ON d.rev=s.rev WHERE s.rev=a.rev AND s.message=m.id AND s.body IS m.content_text AND d.owner=?) " +
      "WHERE t.status='open' AND " + canRead('m','?') + ' AND ' + sameAccount +
      " GROUP BY t.id ORDER BY t.id DESC LIMIT 200").all(owner, owner);
  }
  function evidence(id) {
    let todo;
    try { todo = current(id); } catch (error) {
      if (error.message === 'todo_unavailable') fail('not_found', 404);
      throw error;
    }
    const quote = todo.title + (todo.due_at ? '\n截止时间 ' + todo.due_at : '');
    return { id: 'todo-' + todo.id, documentId: 'todo-' + todo.id, revision: hash(quote), locator: '当前待办 #' + todo.id, quote, title: '当前待办' };
  }
  function sourceChunks() {
    return db.prepare("SELECT c.*,d.id AS doc FROM kb_chunks c JOIN kb_documents d ON d.rev=c.rev WHERE d.owner=? AND d.state='active' AND " +
      liveAdmission + ' ORDER BY c.id LIMIT 24').all(owner);
  }
  return { plan, check, apply, list, evidence, sourceChunks, liveAdmission,
    live: id => !!db.prepare('SELECT 1 FROM kb_documents d WHERE d.id=? AND d.owner=? AND ' + liveAdmission).get(id, owner) };
}

module.exports = { createTodoKnowledge };
