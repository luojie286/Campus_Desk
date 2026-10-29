// 仅验证浏览器环境和脱敏本地布局，不访问私人文档，不发送消息。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const modulePath = process.env.LAB_PLAYWRIGHT_PATH || 'playwright';
  const { chromium } = require(modulePath);
  const result = { checkedAt: new Date().toISOString(), scope: 'local synthetic fixture; public unauthenticated navigation', checks: [] };
  let browser;
  try {
    // 复用已安装的 Edge；不下载浏览器，不使用个人浏览器配置。
    browser = await chromium.launch({ headless: true, channel: process.env.LAB_BROWSER_CHANNEL || 'msedge' });
    result.checks.push({ name: 'chromium_launch', passed: true, version: browser.version() });
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><meta charset="utf-8">
      <table id="identity"><tr><td colspan="3">测试说明，不是表头</td></tr>
      <tr><th>姓名</th><th>学号</th><th>假期去向</th></tr>
      <tr><td>示例</td><td>示例学号</td><td>示例</td></tr>
      <tr><td>测试甲</td><td>00123</td><td></td></tr>
      <tr><td>测试甲</td><td>00999</td><td>他人数据</td></tr></table>
      <table id="section"><tr><th>楼栋</th><th>姓名</th><th>学号</th></tr>
      <tr><td rowspan="2">网安楼</td><td>其他测试者</td><td>00888</td></tr>
      <tr><td></td><td></td></tr><tr><td>实验楼</td><td></td><td></td></tr></table>`);
    // 学号按文本匹配，同时核对姓名，排除同名者及示例行。
    const row = page.locator('#identity tr').filter({ has: page.getByRole('cell', { name: '00123', exact: true }) });
    assert.equal(await row.count(), 1);
    assert.equal(await row.locator('td').nth(0).innerText(), '测试甲');
    assert.equal(await page.locator('#identity tr').nth(1).locator('th').allTextContents().then(x => x.join(',')), '姓名,学号,假期去向');
    result.checks.push({ name: 'identity_and_header', passed: true });

    // 用合成页面模拟他人插行。真实平台必须另行实现其结构读取方式。
    await page.evaluate(() => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>新插入者</td><td>00777</td><td>保留</td>';
      document.querySelector('#identity').rows[3].before(tr);
    });
    assert.equal(await row.locator('td').nth(1).innerText(), '00123');
    await row.locator('td').nth(2).evaluate(cell => { cell.textContent = '待用户确认的测试值'; });
    assert.equal(await row.locator('td').nth(2).innerText(), '待用户确认的测试值');
    assert.equal(await page.getByRole('cell', { name: '他人数据', exact: true }).count(), 1);
    result.checks.push({ name: 'relocate_after_row_insert_and_readback', passed: true });

    const section = await page.locator('#section').evaluate(table => {
      let group = '';
      for (const row of Array.from(table.rows).slice(1)) {
        const cells = Array.from(row.cells);
        if (cells.length === 3) group = cells.shift().textContent;
        if (group === '网安楼' && cells.every(cell => cell.textContent === '')) {
          cells[0].textContent = '测试甲（待补充）';
          return { group, marker: cells[0].textContent, studentId: cells[1].textContent };
        }
      }
      return null;
    });
    assert.deepEqual(section, { group: '网安楼', marker: '测试甲（待补充）', studentId: '' });
    result.checks.push({ name: 'merged_section_visible_placeholder_only', passed: true });
    // 只访问公开首页；不复用用户浏览器登录态，不尝试登录或编辑。
    for (const url of ['https://docs.qq.com/', 'https://www.kdocs.cn/', 'https://www.wps.cn/']) {
      const publicPage = await browser.newPage();
      try {
        const response = await publicPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const destination = new URL(publicPage.url());
        result.checks.push({ name: 'public_navigation', url, status: response?.status(), title: await publicPage.title(), finalUrl: destination.origin + destination.pathname });
      } catch (error) {
        result.checks.push({ name: 'public_navigation', url, error: String(error.message).slice(0, 220) });
      } finally {
        await publicPage.close();
      }
    }
  } catch (error) {
    result.failure = String(error.stack);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    const output = path.resolve('docs/verification/browser-results.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
}
main();
