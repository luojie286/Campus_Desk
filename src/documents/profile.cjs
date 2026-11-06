const { createHash } = require('node:crypto');
const { createJobRepository } = require('../db/repositories/jobs.cjs');
const { transaction } = require('../db/transaction.cjs');

const baseKeys = ['name', 'student_id', 'sex', 'age'];
const validKey = key => typeof key === 'string' && /^[a-z][a-z0-9_]{0,49}$/i.test(key) &&
  !Object.prototype.hasOwnProperty.call(Object.prototype, key);

function fields(db) {
  const result = {};
  const legacy = db.prepare('SELECT * FROM profile WHERE id=1').get();
  for (const key of baseKeys) if (legacy) result[key] = String(legacy[key]);
  for (const row of db.prepare('SELECT key,value FROM profile_fields').all()) {
    if (validKey(row.key)) result[row.key] = row.value;
  }
  for (const row of db.prepare('SELECT key FROM profile_deleted_fields').all()) delete result[row.key];
  return result;
}

function effective(values, answers = []) {
  const profile = { ...values };
  for (const answer of answers) {
    if (Object.hasOwn(profile, answer.key)) profile[answer.key] = answer.value;
  }
  return profile;
}

function fingerprint(plan, values, answers = []) {
  const keys = [...new Set([...baseKeys.slice(0, 2), ...(plan.columns || []).map(column => column.field),
    ...(plan.changes || []).map(change => change.field), ...(plan.missing || []).map(item => item.field)].filter(validKey))].sort();
  const profile = effective(values, answers);
  const selected = keys.map(key => [key, profile[key] ?? null]);
  return createHash('sha256').update(JSON.stringify(selected)).digest('hex');
}

function enabled(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kb_schema'").get() &&
    !!db.prepare('SELECT 1 FROM kb_schema WHERE version=2').get();
}

function planCurrent(plan, values, answers, requireFingerprint) {
  if (!plan.profileFingerprint) return !requireFingerprint;
  return plan.profileFingerprint === fingerprint(plan, values, answers);
}

function invalidateTask(db, taskId, planId) {
  return transaction(db, () => {
    const task = db.prepare("SELECT id,account_ref FROM tasks WHERE id=? AND current_plan_id=? AND state IN ('awaiting_approval','approved')").get(taskId, planId);
    if (!task) return false;
    const now = new Date().toISOString();
    db.prepare("UPDATE plans SET status='superseded' WHERE id=?").run(planId);
    db.prepare("UPDATE operations SET state='failed_terminal',error_class='profile_changed',finished_at=? WHERE task_id=? AND plan_id=? AND state='queued'")
      .run(now, taskId, planId);
    db.prepare("UPDATE tasks SET state='preparing',state_version=state_version+1,current_plan_id=NULL,waiting_reason='profile_changed',updated_at=? WHERE id=?")
      .run(now, taskId);
    createJobRepository(db).enqueue({ type: 'prepare_task', payload: { taskId, accountRef: task.account_ref }, runAt: now });
    return true;
  });
}

function invalidateChanged(db) {
  if (!enabled(db)) return;
  const values = fields(db);
  const plans = db.prepare("SELECT t.id AS task,p.id,p.plan_json FROM tasks t JOIN plans p ON p.id=t.current_plan_id WHERE t.state IN ('awaiting_approval','approved')").all();
  for (const row of plans) {
    const answers = db.prepare('SELECT key,value FROM task_answers WHERE task_id=? ORDER BY task_version').all(row.task);
    let current = false;
    try { current = planCurrent(JSON.parse(row.plan_json), values, answers, true); } catch {}
    if (!current) invalidateTask(db, row.task, row.id);
  }
  for (const run of db.prepare("SELECT id,plan FROM runs WHERE state='awaiting_approval'").all()) {
    let current = false;
    try { current = planCurrent(JSON.parse(run.plan), values, [], true); } catch {}
    if (!current) db.prepare("UPDATE runs SET state='received',error='profile_changed',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), run.id);
  }
}

function assertWritable(db) {
  // 实际写表期间拒绝资料变更，其他连接也会看到执行状态。
  const tasksExist = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get();
  if ((tasksExist && db.prepare("SELECT 1 FROM tasks WHERE state IN ('executing','verifying') LIMIT 1").get()) ||
      db.prepare("SELECT 1 FROM runs WHERE state='writing' LIMIT 1").get()) {
    throw Object.assign(Error('profile_busy'), { status: 409 });
  }
}

function setField(db, key, value, source = 'manual') {
  if (!validKey(key)) throw Error('invalid_profile_field');
  transaction(db, () => {
    assertWritable(db);
    if (value === null) {
      db.prepare('INSERT OR IGNORE INTO profile_deleted_fields VALUES(?)').run(key);
      db.prepare('DELETE FROM profile_fields WHERE key=?').run(key);
    } else {
      db.prepare('DELETE FROM profile_deleted_fields WHERE key=?').run(key);
      db.prepare('INSERT OR REPLACE INTO profile_fields(key,value,source,updated_at) VALUES(?,?,?,?)')
        .run(key, String(value), source, new Date().toISOString());
    }
    invalidateChanged(db);
  });
}

function saveProfile(db, profile) {
  transaction(db, () => {
    assertWritable(db);
    const now = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO profile VALUES(1,?,?,?,?,?)').run(profile.name, String(profile.student_id), profile.sex, profile.age, now);
    // 显式更新基础资料时同步覆盖键值视图并清除删除标记。
    for (const key of baseKeys) {
      db.prepare('DELETE FROM profile_deleted_fields WHERE key=?').run(key);
      db.prepare('INSERT OR REPLACE INTO profile_fields VALUES(?,?,?,?)').run(key, String(profile[key]), 'profile', now);
    }
    invalidateChanged(db);
  });
}

function beginLegacyWrite(db, runId, plan, expectedState = 'awaiting_approval') {
  transaction(db, () => {
    const run = db.prepare('SELECT state FROM runs WHERE id=?').get(runId);
    if (run?.state !== expectedState || !planCurrent(plan, fields(db), [], enabled(db))) throw Error('profile_changed');
    db.prepare("UPDATE runs SET state='writing',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), runId);
  });
}

module.exports = { fields, effective, fingerprint, enabled, planCurrent, invalidateTask, setField, saveProfile, validKey, beginLegacyWrite, transaction };
