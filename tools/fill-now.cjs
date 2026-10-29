// 手动执行一次“准备 -> 写入 -> 回读”的维护工具。
// 适用场景：QQ 接入尚未就绪，但用户已明确授权修改配置中的指定测试表。
// 它复用与事件流程相同的 TencentSheet 执行器，并在 runs 中留下 manual: 记录。
// 限制：manual: 记录不会被 serve 的自动 drain 处理；若写入中断，必须在独立进程中回读核对。
const fs = require('node:fs');
const { openStore } = require('../src/core.cjs');
const { TencentSheet, column } = require('../src/tencent.cjs');

async function main() {
  // 写入是不可逆的外部操作，必须显式带上 --yes 才执行。
  if (!process.argv.includes('--yes')) throw Error('refusing_to_write_without_--yes');
  const config = JSON.parse(fs.readFileSync('.private/config.json', 'utf8'));
  const store = openStore('.private/poc.sqlite');
  const profile = store.profile();
  const sheet = new TencentSheet(config);
  let runId = null;
  try {
    await sheet.open(config.allowed_document);
    const plan = await sheet.prepare(profile);
    console.log(JSON.stringify({
      stage: 'prepared',
      identityRow: plan.identityRow,
      changes: plan.changes.map(change => ({ cell: column(change.col) + change.row, field: change.field }))
    }));
    if (!plan.changes.length) {
      console.log(JSON.stringify({ stage: 'no_changes' }));
      return;
    }
    if (!await sheet.isEditable()) throw Error('document_read_only_or_login_required');

    // 直接以 prepared 状态入库，避免后台 serve 每两秒的 drain 抢到同一记录；
    // 后台只处理 received 状态。
    const now = new Date().toISOString();
    const sourceKey = 'manual:fill:' + now;
    const inserted = store.db.prepare(
      "INSERT INTO runs(source_key,url,state,plan,updated_at) VALUES(?,?,'prepared',?,?)"
    ).run(sourceKey, config.allowed_document, JSON.stringify(plan), now);
    runId = Number(inserted.lastInsertRowid);

    store.update(runId, 'writing', plan);
    await sheet.apply(plan, profile);
    if (!await sheet.verify(profile)) throw Error('readback_mismatch');
    store.update(runId, 'completed', plan);
    console.log(JSON.stringify({
      stage: 'completed',
      runId,
      changes: plan.changes.map(change => ({ cell: column(change.col) + change.row, field: change.field }))
    }));
  } catch (error) {
    if (runId !== null) {
      // 与事件流程一致：已进入写入阶段后出错，不自动重试，标记为结果不明。
      const current = store.db.prepare('SELECT state FROM runs WHERE id=?').get(runId);
      store.update(runId, current.state === 'writing' ? 'outcome_unknown' : 'failed', null,
        String(error.message).split('\n')[0].slice(0, 160));
    }
    throw error;
  } finally {
    await sheet.close();
  }
}

main().catch(error => {
  console.error(String(error.message).split('\n')[0]);
  process.exitCode = 1;
});
