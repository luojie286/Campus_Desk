// Capture the actual desktop UI using synthetic API responses only.
// Never load .private/, contact the business backend, or allow modifying requests.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs/images/readme');
const stamp = '2026-11-05T00:40:00Z';
const target = 'https://docs.qq.com/sheet/DEMO_REGISTRATION';

function message(id, text, group, name, links = [], files = []) {
  return {id, platform: 'qq', conversation: {type: 'group', id: String(group), name},
    sender: {id: String(2000 + id), name: ['学习委员', '活动负责人', '课程助教'][id - 1]},
    source_time: stamp, received_at: stamp, kind: 'text', text, links, files, read: id === 3};
}
const messages = [
  message(1, '请大家在周五前提交实验报告，使用群文件中的最新模板。补充：报告命名为“学号-实验名称”，提交前检查附件。', 1001, '课程通知 · 演示'),
  message(2, '本学期的信息登记表已更新，请核对自己的姓名、学号，并补充专业与年级。', 1001, '课程通知 · 演示', [target]),
  message(3, '周三下午有一场技术分享，活动安排和报名要求见附件，感兴趣的同学可以提前准备。', 1002, '校园活动 · 演示', [],
    [{id: 1, file_name: '技术分享活动安排.pdf', mime_type: 'application/pdf', size_bytes: 245760, download_state: 'downloaded', text_state: 'extracted'}])
];
const suggestions = [{id: 101, message_id: 1, kind: 'todo', title: '周五前提交实验报告',
  summary: '通知和补充说明已合并：使用最新模板，按要求命名，并检查附件后提交。', category: 'action',
  confidence: 0.94, status: 'pending', rationale: null, created_at: stamp, decided_at: null,
  links: [], source_count: 2, sources: []}];
const todos = ['整理课程笔记', '准备周三技术分享的问题', '完成实验报告并检查附件'].map((title, index) =>
  ({id: 401 + index, title, status: 'open', priority: 0, due_at: null, created_at: stamp, updated_at: stamp}));
const plan = {id: 301, task_id: 201, version: 1, kind: 'doc_fill', document_ref: target, digest: 'synthetic-readme-plan',
  status: 'current', created_at: stamp, plan: {identityMode: 'full', identityRow: 3,
    changes: [{row: 3, col: 3, field: 'major', before: '', value: '计算机科学与技术'},
      {row: 3, col: 4, field: '年级', before: '', value: '大二'}], missing: [], warnings: []}};
const tasks = [
  {id: 201, todo_id: null, kind: 'doc_fill', executor_type: 'tencent_sheet', account_ref: '9999', target_ref: target,
    state: 'awaiting_approval', state_version: 3, waiting_reason: null, current_plan_id: 301,
    created_at: stamp, updated_at: stamp, completed_at: null, metadata: {}, plan, questions: [], answers: [], latest_operation: null}
];
const sources = [
  {conversation_type: 'group', conversation_id: '1001', conversation_name: '课程通知 · 演示', total: 12, unread: 2,
    last_at: stamp, last_sender_id: '2002', last_sender_name: '活动负责人', last_text: messages[1].text},
  {conversation_type: 'group', conversation_id: '1002', conversation_name: '校园活动 · 演示', total: 8, unread: 0,
    last_at: stamp, last_sender_id: '2003', last_sender_name: '课程助教', last_text: messages[2].text}
];

function fixture(url) {
  const endpoint = url.pathname.replace(/^\/api/, '');
  const lists = {'/v1/sources': sources, '/v1/messages': messages, '/v1/suggestions': suggestions,
    '/v1/todos': todos, '/v1/tasks': tasks, '/v1/listen-sources': [], '/v1/notifications': []};
  if (endpoint === '/health') return {running: true, sourceConfigured: true};
  if (Object.hasOwn(lists, endpoint)) return {items: lists[endpoint], unread: 0};
  if (endpoint === '/v1/tasks/201') return tasks[0];
  const found = endpoint.match(/^\/v1\/messages\/(\d+)$/);
  if (found) return {...messages.find(item => item.id === Number(found[1])), suggestions};
  throw Error('Unexpected screenshot API endpoint: ' + endpoint);
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  fs.mkdirSync(output, {recursive: true});
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const vite = spawn(process.execPath, [path.join(root, 'desktop/node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {cwd: path.join(root, 'desktop'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Preview startup timeout')), 20000);
      vite.stdout.on('data', chunk => {if (chunk.toString().includes('Local:')) {clearTimeout(timer); resolve();}});
      vite.once('error', error => {clearTimeout(timer); reject(error);});
      vite.once('exit', () => {clearTimeout(timer); reject(Error('Preview exited before capture'));});
    });
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const context = await browser.newContext({viewport: {width: 1440, height: 1040}, deviceScaleFactor: 1.5,
      locale: 'zh-CN', timezoneId: 'Asia/Yakutsk', serviceWorkers: 'block'});
    const violations = [];
    // Handle every API call before Vite's proxy can contact port 9087.
    // All non-local resources are blocked, including remote font requests.
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) return route.abort();
      if (!url.pathname.startsWith('/api')) return route.continue();
      if (request.method() !== 'GET') {
        violations.push('modifying_request');
        return route.fulfill({status: 405, json: {error: 'readme_read_only'}});
      }
      try {await route.fulfill({json: fixture(url)});}
      catch (error) {violations.push(error.message); await route.fulfill({status: 404, json: {error: 'fixture_missing'}});}
    });
    await context.addInitScript(() => {
      localStorage.setItem('desk.apiToken', 'synthetic-readme-only');
      localStorage.setItem('desk.apiBase', '/api');
    });
    const page = await context.newPage();
    page.on('pageerror', error => violations.push(error.message));
    await page.goto(base, {waitUntil: 'networkidle'});
    await page.getByRole('heading', {name: '周五前提交实验报告', exact: true}).waitFor();
    await page.screenshot({path: path.join(output, 'desktop-inbox.png'), animations: 'disabled'});
    await page.getByRole('button', {name: '查看审批', exact: true}).click();
    await page.getByRole('heading', {name: '拟填内容', exact: true}).waitFor();
    await page.screenshot({path: path.join(output, 'desktop-approval.png'), animations: 'disabled'});
    if (violations.length) throw Error(violations.join('; '));
    // Android previews are rendered by the real Compose UI in ScreenTest.
    // They are explicitly labelled Robolectric previews, not device screenshots.
    const mobile = path.join(root, 'mobile/android/app/build/reports/mobile-preview');
    for (const name of ['inbox', 'plan', 'todos', 'briefing']) {
      const source = path.join(mobile, name + '.png');
      if (!fs.existsSync(source)) throw Error('Run Android ScreenTest before capture');
      fs.copyFileSync(source, path.join(output, 'android-' + name + '.png'));
    }
    console.log('Saved desktop screenshots and Android Compose previews to docs/images/readme/');
  } finally {
    if (browser) await browser.close();
    vite.kill();
  }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
