// Node 适配器读 Python 管理的工作区记录，不从请求或 QQ 当前账号推断资料所有者。
function resolveWorkspace(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_workspaces'").get();
  if (!exists) return null;
  const row = db.prepare('SELECT workspace_id FROM local_workspaces WHERE slot=1').get();
  return row ? { id: row.workspace_id } : null;
}

function historyPredicate(message, workspace) {
  // 两个参数均为仓储内部固定的 SQL 别名或占位符。
  return "EXISTS (SELECT 1 FROM workspace_source_bindings wb WHERE wb.workspace_id=" + workspace +
    " AND wb.provider=" + message + ".platform AND wb.account_ref=" + message + ".account_ref AND wb.history_allowed=1)";
}

function accountHasHistory(db, account, workspace = resolveWorkspace(db)) {
  return !workspace || !!db.prepare("SELECT 1 FROM workspace_source_bindings WHERE workspace_id=? AND provider='qq' AND account_ref=? AND history_allowed=1")
    .get(workspace.id, String(account || ''));
}

module.exports = { resolveWorkspace, historyPredicate, accountHasHistory };
