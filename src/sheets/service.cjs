const { canonicalUrl } = require('../core.cjs');
const { fail } = require('../knowledge/files.cjs');
const { transaction } = require('../db/transaction.cjs');
const { accountHasHistory } = require('../workspace/context.cjs');

function queueApprovedPlan(tasks, jobs, input) {
  return tasks.approve({ ...input, onApproved({ task, operation }) {
    jobs.enqueue({ type: 'execute_operation',
      payload: { taskId: task.id, accountRef: task.account_ref, operationId: operation.id } });
  } });
}

function createSheetService({ db, tasks, jobs, workspace = null, enabled = true, execute = false }) {
  function canReadAccount(account) {
    return accountHasHistory(db, account, workspace);
  }

  function allowedTask(task) {
    if (!workspace) return true; // 原命令在尚未迁移的库上维持旧账号检查。
    const binding = db.prepare('SELECT origin_kind FROM workspace_tasks WHERE task_id=? AND workspace_id=?')
      .get(task.id, workspace.id);
    if (!binding) return false;
    return ['desktop', 'tool'].includes(binding.origin_kind) ? task.account_ref === workspace.id : canReadAccount(task.account_ref);
  }

  function prepareFillPlan({ target, requestId, origin = 'desktop', message, now = new Date().toISOString() }) {
    if (!enabled) fail('capability_disabled', 503);
    if (typeof target !== 'string' || target.length > 2048) fail('invalid_target');
    let url;
    try { url = canonicalUrl(target); } catch { fail('invalid_target'); }
    if (!['message','desktop','tool'].includes(origin)) fail('invalid_origin');
    if (origin !== 'message' && (!workspace || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(requestId))) {
      fail('invalid_input');
    }
    return transaction(db, () => {
      const messageSource = origin === 'message';
      if (messageSource && (!message?.id || !canReadAccount(message.account_ref))) fail('outside_scope', 403);
      const accountRef = messageSource ? message.account_ref : workspace.id;
      const requestKey = messageSource ? 'message:' + message.id + ':' + url : origin + ':' + requestId;
      const task = tasks.create({ accountRef, requestKey, targetRef: url,
        metadata: messageSource ? { messageId: message.id } : { origin }, createdAt: now });
      if (task.target_ref !== url) fail('idempotency_conflict', 409);
      if (workspace) {
        if (task.created) db.prepare('INSERT INTO workspace_tasks VALUES(?,?,?)').run(task.id, workspace.id, origin);
        if (!allowedTask(task)) fail('outside_scope', 403);
      }
      if (task.created) jobs.enqueue({ type: 'prepare_task', payload: { taskId: task.id, accountRef }, runAt: now });
      return task;
    });
  }

  function taskFor(id) {
    const task = tasks.getAny({ id });
    if (!task || !allowedTask(task)) fail('not_found', 404);
    return task;
  }

  function listTasks() {
    if (!workspace) return [];
    return db.prepare('SELECT t.* FROM tasks t JOIN workspace_tasks w ON w.task_id=t.id WHERE w.workspace_id=? ORDER BY t.updated_at DESC,t.id DESC LIMIT 100')
      .all(workspace.id).filter(allowedTask);
  }

  function prepareFromMessage(message, target, now) {
    return enabled && canReadAccount(message.account_ref)
      ? prepareFillPlan({ message, target, now, origin: 'message' }) : null;
  }

  return { prepareFillPlan, prepareFromMessage, allowedTask, taskFor, listTasks, tasks, jobs, enabled, execute };
}

module.exports = { createSheetService, queueApprovedPlan };
