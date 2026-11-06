const { ingestEvent } = require('../intake/onebot.cjs');
const { extractLinks, eventKey } = require('../core.cjs');
const { resolveWorkspace, historyPredicate } = require('../workspace/context.cjs');
const { transaction } = require('../db/transaction.cjs');
const { invokePolicy } = require('../python/policy.cjs');

function selectWithPython(input) {
  return invokePolicy('campusdesk.messages', input);
}

function listAuthorizedMessages(db, workspace, query = {}) {
  const limit = Math.min(20, Math.max(1, Number.isSafeInteger(query.limit) ? query.limit : 10));
  const before = Number.isSafeInteger(query.before) && query.before > 0 ? query.before : Number.MAX_SAFE_INTEGER;
  const text = typeof query.text === 'string' ? query.text.trim().slice(0, 200) : '';
  return db.prepare("SELECT m.id,m.platform,m.conversation_type,m.conversation_name,m.received_at,substr(m.content_text,1,600) AS excerpt " +
    "FROM messages m WHERE m.id<? AND " + historyPredicate('m','?') +
    " AND (?='' OR instr(m.content_text,?)>0) ORDER BY m.id DESC LIMIT ?").all(before, workspace.id, text, text, limit);
}

function createMessageService({ store, config, sources, messages, jobs, files, select = selectWithPython }) {
  const { db } = store;
  function context() {
    const account = String(config.account_id || '');
    const workspace = resolveWorkspace(db);
    const binding = workspace && db.prepare("SELECT ingress_enabled FROM workspace_source_bindings WHERE workspace_id=? AND provider='qq' AND account_ref=?")
      .get(workspace.id, account);
    return { account, ingress_allowed: !!account && (!workspace || binding?.ingress_enabled === 1) };
  }
  async function ingestMessage(event) {
    const actor = context();
    const rows = sources.list({ accountRef: actor.account });
    const decision = await select({
      context: actor,
      event: Object.fromEntries(['post_type','message_type','self_id','user_id','group_id','message_id'].map(key => [key,event[key]])),
      sources: rows.map(row => ({ id: row.id, platform: row.platform, enabled: row.enabled, type: row.conversation_type,
        account: row.account_ref, conversation: row.conversation_id, sender: row.sender_id }))
    });
    if (!decision.source_id) return { accepted: 0, reason: decision.reason || 'source_filtered' };
    return transaction(db, () => {
      // Python 处理期间操作者可能撤销来源或更换账号。写入前以当前数据库重查。
      const current = context();
      if (!current.ingress_allowed || current.account !== actor.account) return { accepted: 0, reason: 'source_filtered' };
      const matched = sources.get({ id: decision.source_id, accountRef: actor.account });
      const before = rows.find(row => row.id === decision.source_id);
      const bindingFields = ['platform', 'conversation_type', 'conversation_id', 'sender_id', 'adapter_instance'];
      if (!before || !matched || !matched.enabled || bindingFields.some(key => matched[key] !== before[key])) {
        return { accepted: 0, reason: 'source_filtered' };
      }
      const ingested = config.messageCenter ? ingestEvent({ event, config, messages, jobs, files, source: sources.toLegacySource(matched) }) : null;
      if (ingested?.reason) return { accepted: 0, reason: ingested.reason };
      let accepted = 0;
      if (config.pipeline !== 'v2') {
        const key = eventKey(event);
        for (const url of extractLinks(event)) accepted += Number(store.enqueue(key, url));
      }
      return { accepted, stored: ingested ? !!ingested.stored : null, messageId: ingested?.messageId ?? null,
        duplicate: ingested ? !!ingested.duplicate : null };
    });
  }
  return { ingestMessage };
}

module.exports = { createMessageService, listAuthorizedMessages };
