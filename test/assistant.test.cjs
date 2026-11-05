const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { test } = require('node:test');
const { once } = require('node:events');
const { createCanvas } = require('@napi-rs/canvas');
const JSZip = require('jszip');
const { openStore } = require('../src/core.cjs');
const { applyMigrations } = require('../src/db/migrate.cjs');
const { initialize } = require('../src/knowledge/repository.cjs');
const { createAssistant } = require('../src/assistant/api.cjs');

const token = 'fixture-owner-only-0000000000000000000000000000';
const live = process.env.LAB1_ASSISTANT_LIVE_FIXTURE === '1';

async function fixture(t, { externalTrash = false, modelReply, liveModel = live, outputLimit = 256 } = {}) {
  const parent = fs.realpathSync(os.tmpdir());
  const folder = fs.mkdtempSync(path.join(parent, 'lab1-assistant-test-'));
  const source = path.join(folder, 'source');
  const storage = path.join(folder, '.private', 'kb');
  fs.mkdirSync(source);
  for (const subfolder of ['objects', 'trash']) fs.mkdirSync(path.join(storage, subfolder), { recursive: true });
  let trashRoot;
  if (externalTrash && process.platform === 'win32') {
    const local = fs.realpathSync('.private');
    trashRoot = fs.mkdtempSync(path.join(local, 'lab1-trash-fixture-'));
    t.after(() => {
      assert.equal(path.dirname(fs.realpathSync(trashRoot)), local);
      assert.match(path.basename(trashRoot), /^lab1-trash-fixture-/);
      fs.rmSync(trashRoot, { recursive: true, force: true });
    });
  }
  const { db } = openStore(':memory:');
  applyMigrations(db);
  initialize(db);
  const calls = [];
  let handler;
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://127.0.0.1')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const model = { id: 'fixture', label: '合成模型', model: 'deepseek-chat', credential: 'DEEPSEEK_API_KEY',
    endpoint: 'https://api.deepseek.com/chat/completions', output: outputLimit, timeout: 30000 };
  const secondModel = { ...model, id: 'fixture-review', model: liveModel ? model.model : 'fixture-review-model' };
  const config = { db, owner: 'fixture-account', storage: fs.realpathSync(storage), trashRoot,
    languagePath: path.resolve('.private/ocr'), token, models: [model, secondModel], port };
  const previous = process.env.LAB1_ASSISTANT_MOCK_TOKEN;
  process.env.LAB1_ASSISTANT_MOCK_TOKEN = 'fixture';
  if (!liveModel) {
    model.credential = 'LAB1_ASSISTANT_MOCK_TOKEN';
    secondModel.credential = model.credential;
    config.fetchModel = async (_url, options) => {
      const payload = JSON.parse(options.body);
      const input = JSON.parse(payload.messages[1].content);
      calls.push(input);
      if (modelReply) return modelReply(input, payload, options.signal);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        answer: '合成结果 4817', citations: [input.evidence[0].id], supplement: ''
      }) } }], usage: { total_tokens: 12 } });
    };
  }
  handler = createAssistant(config);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    if (previous === undefined) delete process.env.LAB1_ASSISTANT_MOCK_TOKEN;
    else process.env.LAB1_ASSISTANT_MOCK_TOKEN = previous;
    assert.equal(path.dirname(fs.realpathSync(folder)), parent);
    assert.match(path.basename(folder), /^lab1-assistant-test-/);
    fs.rmSync(folder, { recursive: true, force: true });
  });

  async function request(route, body, status = 200, headers = {}) {
    const result = await fetch('http://127.0.0.1:' + port + '/v1/assistant' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await result.json();
    assert.equal(result.status, status, route + ' ' + JSON.stringify(data.error || {}));
    return data.data ?? data.error;
  }
  const preview = body => request('/previews', body, 201);
  const decide = (draft, decision = 'approve', id = randomUUID(), status = 200) =>
    request('/previews/' + draft.id + '/decision', { decision, digest: draft.digest, clientRequestId: id }, status);
  const approve = async body => decide(await preview(body));
  const root = (await approve({ kind: 'grant_root', path: source })).rootId;
  const ask = async (question, useModel = false, sourceIds) => {
    const session = await request('/sessions', {}, 201);
    await request('/sessions/' + session.id + '/turns', { question, sourceIds, useModel, modelId: 'fixture', clientRequestId: randomUUID() }, 202);
    try {
      const deadline = Date.now() + 32000;
      while (Date.now() < deadline) {
        const state = await request('/sessions/' + session.id);
        if (state.turns[0].result) return state.turns[0].result;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw Error('turn_timeout');
    } finally {
      await request('/sessions/' + session.id + '/close', {});
    }
  };
  return { folder, source, storage, trashRoot, db, request, root, preview, decide, approve, ask, calls,
    restart: () => { handler = createAssistant(config); }, base: 'http://127.0.0.1:' + port + '/v1/assistant' };
}

test('M1 A01 A03 A08: 20 questions, preview, versioning and authorization', async t => {
  const f = await fixture(t);
  const subjects = ['Spring MVC', '线程栈', '分布式锁', '深度优先', '图书馆校历', '柠檬电池',
    'TLS 握手', '指针数组', '偏序关系', '回归方差', '线性代数', '异步时钟', '双向链表',
    '版本向量', '城市湿地', '天线阻抗'];
  const names = subjects.map((subject, i) => {
    const name = 'fixture-' + i + '.md';
    fs.writeFileSync(path.join(f.source, name), subject + ' 的专用样本编号为 4817。');
    return name;
  });
  const draft = await f.preview({ kind: 'import', rootId: f.root, names });
  assert.equal(fs.readdirSync(path.join(f.storage, 'objects')).length, 0);
  assert.equal((await f.decide(draft, 'reject')).state, 'rejected');
  assert.equal((await f.request('/knowledge')).items.length, 0);
  const approved = await f.preview({ kind: 'import', rootId: f.root, names });
  const id = randomUUID();
  assert.equal((await f.decide(approved, 'approve', id)).imported, 16);
  assert.equal((await f.decide(approved, 'approve', id)).imported, 16);
  assert.equal(fs.readdirSync(path.join(f.storage, 'objects')).length, 16);
  assert.equal((await f.approve({ kind: 'import', rootId: f.root, names })).unchanged, 16);
  let hits = 0;
  for (const [index, subject] of subjects.entries()) {
    const result = await f.ask('请解释 ' + subject);
    if (result.evidence.some(item => item.title === names[index])) hits++;
    for (const item of result.evidence) assert.equal((await f.request('/evidence/' + item.id)).quote, item.quote);
  }
  assert.ok(hits >= 14, 'Recall@8: ' + hits + '/16');
  for (const missing of ['青铜冶炼', '冰川观测', 'Mandelbrot', '咖啡烘焙']) {
    assert.equal((await f.ask(missing)).status, 'no_evidence');
  }
  t.diagnostic('Recall@8 ' + hits + '/16; unsupported questions 4/4');
  const doc = (await f.request('/knowledge')).items.find(item => item.name === names[0]);
  const first = await f.ask(subjects[0], true, [doc.id]);
  assert.equal(first.status, 'cloud_grant_required');
  assert.equal(f.calls.length, 0);
  await f.approve({ kind: 'cloud_grant', documentId: doc.id });
  const answered = await f.ask(subjects[0] + ' 编号', true, [doc.id]);
  assert.equal(answered.status, 'answered');
  assert.ok(answered.evidence.every(item => item.documentId === doc.id));
  if (!live) assert.equal(f.calls[0].evidence.length, 1);
  await f.approve({ kind: 'cloud_revoke', documentId: doc.id });
  assert.equal((await f.ask(subjects[0], true, [doc.id])).status, 'cloud_grant_required');
  if (!live) assert.equal(f.calls.length, 1);
  if (live) t.diagnostic(JSON.stringify({ provider: 'DeepSeek', syntheticRequests: 1, tokens: answered.tokens }));
  const outdated = await f.preview({ kind: 'import', rootId: f.root, names: [names[0]] });
  fs.writeFileSync(path.join(f.source, names[0]), 'Spring MVC 合成更新 9412');
  assert.equal((await f.decide(outdated, 'approve', randomUUID(), 409)).code, 'preview_changed');
  assert.equal((await f.request('/knowledge/' + doc.id)).status, 'stale');
  assert.equal((await f.request('/evidence/' + answered.evidence[0].id, undefined, 404)).code, 'not_found');
  assert.equal((await f.approve({ kind: 'import', rootId: f.root, names: [names[0]] })).imported, 1);
  assert.match((await f.ask(subjects[0], false, [doc.id])).evidence[0].quote, /9412/);
});

test('M1 A04 A05 A08: note and profile changes, trash preserves original, scope fails closed', async t => {
  const f = await fixture(t, { externalTrash: true });
  assert.equal((await f.request('/capabilities', undefined, 401, { Authorization: 'Bearer wrong' })).code, 'unauthorized');
  assert.equal((await f.request('/capabilities', undefined, 403, { Origin: 'https://example.invalid' })).code, 'outside_scope');
  await f.request('/previews', { kind: 'import', rootId: f.root, names: ['../outside.md'] }, 400);
  fs.writeFileSync(path.join(f.folder, 'outside.md'), 'private fixture');
  fs.symlinkSync(f.folder, path.join(f.source, 'escape'), 'junction');
  assert.equal((await f.request('/previews', { kind: 'import', rootId: f.root, names: ['escape/outside.md'] }, 403)).code, 'outside_scope');
  const add = await f.preview({ kind: 'profile', key: 'fixture_field', value: '甲' });
  const value = async () => (await f.request('/profile')).items.find(field => field.key === 'fixture_field')?.value ?? null;
  assert.equal(await value(), null);
  await f.decide(add);
  assert.equal(await value(), '甲');
  await f.approve({ kind: 'profile', key: 'fixture_field', value: '乙' });
  assert.equal(await value(), '乙');
  await f.approve({ kind: 'profile', key: 'fixture_field', value: null });
  assert.equal(await value(), null);

  await f.approve({ kind: 'note', name: 'note.txt', text: '编辑前文本' });
  const note = (await f.request('/knowledge')).items.find(item => item.name === 'note.txt');
  const rejected = await f.preview({ kind: 'note', documentId: note.id, name: 'note.txt', text: '拒绝的内容' });
  await f.decide(rejected, 'reject');
  assert.equal((await f.request('/knowledge/' + note.id)).text, '编辑前文本');
  await f.approve({ kind: 'note', documentId: note.id, name: 'note.txt', text: '编辑后文本' });
  assert.equal((await f.request('/knowledge/' + note.id)).text, '编辑后文本');

  const original = path.join(f.source, 'trash-test.md');
  fs.writeFileSync(original, '雪原蚂蚁');
  await f.approve({ kind: 'import', rootId: f.root, names: ['trash-test.md'] });
  const doc = (await f.request('/knowledge')).items.find(item => item.name === 'trash-test.md');
  await f.decide(await f.preview({ kind: 'trash', documentId: doc.id }), 'reject');
  assert.ok((await f.ask('雪原蚂蚁')).evidence.length);
  const result = await f.approve({ kind: 'trash', documentId: doc.id });
  assert.equal(fs.readFileSync(result.target, 'utf8'), '雪原蚂蚁');
  assert.equal(fs.readFileSync(original, 'utf8'), '雪原蚂蚁');
  if (f.trashRoot) {
    assert.equal(path.dirname(result.target), f.trashRoot);
    t.diagnostic('Trash uses distinct volume: ' + (fs.statSync(f.trashRoot).dev !== fs.statSync(f.storage).dev));
  }
  assert.equal((await f.ask('雪原蚂蚁')).status, 'no_evidence');
});

function pdf(canvas) {
  const { width, height } = canvas;
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4];
  function stream(dict, body) {
    return Buffer.concat([Buffer.from('<< ' + dict + ' /Length ' + body.length + ' >>\nstream\n'), body, Buffer.from('\nendstream')]);
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 180] /Resources << /Font << /F 5 0 R >> >> /Contents 4 0 R >>',
    stream('', Buffer.from('BT /F 28 Tf 20 100 Td (Printed marker 2186) Tj ET')),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 180] /Resources << /XObject << /Im 8 0 R >> >> /Contents 7 0 R >>',
    stream('', Buffer.from('q 640 0 0 180 0 0 cm /Im Do Q')),
    stream('/Type /XObject /Subtype /Image /Width ' + width + ' /Height ' + height +
      ' /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', deflateSync(gray))
  ];
  let body = Buffer.from('%PDF-1.4\n');
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(String(body.length).padStart(10, '0') + ' 00000 n \n');
    body = Buffer.concat([body, Buffer.from((i + 1) + ' 0 obj\n'), Buffer.from(object), Buffer.from('\nendobj\n')]);
  });
  const tail = 'xref\n0 9\n0000000000 65535 f \n' + offsets.join('') +
    'trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n' + body.length + '\n%%EOF\n';
  return Buffer.concat([body, Buffer.from(tail)]);
}

test('M1 A02: normal entry indexes supported documents and scan page anchors', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const canvas = createCanvas(640, 180);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 640, 180);
  context.fillStyle = '#000';
  context.font = '48px Arial';
  context.fillText('Scanned marker 4817', 20, 100);
  fs.writeFileSync(path.join(f.source, 'mixed.pdf'), pdf(canvas));
  fs.writeFileSync(path.join(f.source, 'photo.png'), canvas.toBuffer('image/png'));
  fs.writeFileSync(path.join(f.source, 'photo.jpg'), canvas.toBuffer('image/jpeg'));
  fs.writeFileSync(path.join(f.source, 'plain.txt'), 'TXT独特符号 3156');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>独立段落 6284</w:t></w:r></w:p></w:body></w:document>');
  fs.writeFileSync(path.join(f.source, 'word.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  fs.writeFileSync(path.join(f.source, 'invalid.pdf'), 'broken');
  const error = await f.request('/previews', { kind: 'import', rootId: f.root, names: ['invalid.pdf'] }, 422);
  assert.equal(error.code, 'parse_failed');
  fs.writeFileSync(path.join(f.source, 'empty.md'), '\n');
  await f.approve({ kind: 'import', rootId: f.root, names: ['empty.md'] });
  assert.equal((await f.request('/knowledge')).items.find(item => item.name === 'empty.md').status, 'empty');
  for (const name of ['mixed.pdf', 'photo.png', 'photo.jpg', 'word.docx', 'plain.txt']) {
    const result = await f.approve({ kind: 'import', rootId: f.root, names: [name] });
    assert.equal(result.imported, 1, name);
    t.diagnostic('Imported fixture ' + name);
  }
  const first = await f.ask('2186');
  assert.ok(first.evidence.some(item => item.title === 'mixed.pdf' && item.locator.includes('第 1 页')));
  const second = await f.ask('4817');
  assert.ok(second.evidence.some(item => item.title === 'mixed.pdf' && item.locator.includes('第 2 页 OCR')));
  for (const image of ['photo.png', 'photo.jpg']) assert.ok(second.evidence.some(item => item.title === image));
  assert.ok((await f.ask('6284')).evidence.some(item => item.title === 'word.docx'));
  assert.ok((await f.ask('3156')).evidence.some(item => item.title === 'plain.txt'));
});

test('M1 desktop: import approval and local citation from the built workbench',
  { skip: process.env.LAB1_ASSISTANT_BROWSER_FIXTURE !== '1', timeout: 45000 }, async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const f = await fixture(t, { liveModel: false, modelReply: async (input, payload) => {
      await gate;
      return researchReply(input, payload);
    } });
    fs.writeFileSync(path.join(f.source, '本机验收.md'), '信号标记 8136');
    const messages = require('../src/db/repositories/messages.cjs').createMessageRepository(f.db);
    const suggestions = require('../src/db/repositories/suggestions.cjs').createSuggestionRepository(f.db);
    const raw = messages.insert({ platform: 'qq', adapterInstance: 'fixture', accountRef: 'fixture-account',
      conversationType: 'private', conversationId: '101', senderId: '101', sourceMessageId: 'm2-ui',
      kind: 'text', contentText: '取样地点 7351', receivedAt: new Date().toISOString() });
    suggestions.accept({ id: suggestions.insert({ messageId: raw.id, title: '取样验收待办' }), accountRef: 'fixture-account' });
    const dist = path.resolve('desktop/dist');
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (file !== 'index.html' && !/^assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(file)) return res.writeHead(404).end();
      const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type }).end(fs.readFileSync(path.join(dist, file)));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const browser = await require('playwright').chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    let page = await browser.newPage();
    const relay = async route => {
      const request = route.request();
      const base = new URL(request.url());
      const body = request.postData();
      const pathname = base.pathname.slice('/api/v1/assistant'.length) + base.search;
      // Serve real assistant responses through the fixture's authenticated endpoint.
      const response = await fetch(f.base + pathname, {
        method: request.method(), headers: { Authorization: request.headers().authorization, 'Content-Type': 'application/json' },
        body: body ?? undefined
      });
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    };
    await page.route('**/api/v1/assistant/**', relay);
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByRole('button', { name: '个人知识库', exact: true }).click();
    await page.getByLabel('独立知识库令牌').fill(token);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('button', { name: f.source, exact: true }).click();
    await page.getByLabel('本机验收.md', { exact: true }).check();
    await page.getByRole('button', { name: '预览导入 1 份' }).click();
    const dialog = page.getByRole('dialog', { name: '知识库审批预览' });
    await dialog.getByRole('button', { name: '批准', exact: true }).click();
    await page.getByText('变更已保存。', { exact: true }).waitFor();
    await page.getByLabel('问题', { exact: true }).fill('信号标记');
    await page.getByRole('button', { name: '提问', exact: true }).click();
    await page.getByRole('button', { name: '本机验收.md · 第 1 行', exact: true }).click();
    await page.getByText('信号标记 8136', { exact: true }).waitFor();
    await page.getByLabel('取样验收待办 · 已纳入 0 条来源').check();
    await page.getByRole('button', { name: '预览批量纳入' }).click();
    await dialog.getByText(/取样地点 7351/).waitFor();
    await dialog.getByRole('button', { name: '批准', exact: true }).click();
    await page.getByText('取样验收待办 · 已纳入 1 条来源', { exact: true }).waitFor();
    await page.getByLabel('资料字段名').fill('major');
    await page.getByLabel('资料值').fill('合成专业');
    await page.getByRole('button', { name: '预览更新资料' }).click();
    await dialog.getByText('拟更新 · 合成专业', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '批准', exact: true }).click();
    await page.getByText('专业 · 合成专业', { exact: true }).waitFor();
    await f.approve({ kind: 'cloud_grant', rootId: f.root });
    await page.getByRole('button', { name: 'Deeper Research', exact: true }).click();
    await page.getByLabel('研究问题').fill('信号标记');
    const accepted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/research'));
    await page.getByRole('button', { name: '开始新研究', exact: true }).click();
    const research = (await (await accepted).json()).data;
    assert.equal((await f.request('/research/' + research.id)).state, 'running');
    await page.close();
    release();
    assert.equal((await researchWait(f, research.id)).state, 'completed');
    page = await browser.newPage();
    await page.route('**/api/v1/assistant/**', relay);
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByRole('button', { name: '个人知识库', exact: true }).click();
    await page.getByLabel('独立知识库令牌').fill(token);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('button', { name: 'Deeper Research', exact: true }).click();
    await page.getByText('汇总报告 7316，仅覆盖当前样本', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查看研究过程', exact: true }).click();
    await page.getByText(/agent-2 · 交叉评审/).waitFor();
  });

test('M2 A06: combined approval and batch admission follow the live todo lifecycle', async t => {
  const f = await fixture(t);
  const messages = require('../src/db/repositories/messages.cjs').createMessageRepository(f.db);
  const suggestions = require('../src/db/repositories/suggestions.cjs').createSuggestionRepository(f.db);
  const owner = 'fixture-account';
  function message(sourceMessageId, contentText, accountRef = owner) {
    return messages.insert({ platform: 'qq', adapterInstance: 'fixture', accountRef,
      conversationType: 'private', conversationId: '101', senderId: '101', sourceMessageId,
      kind: 'text', contentText, receivedAt: new Date().toISOString() }).id;
  }
  const raw = message('m2-current', '海蓝色样品 4481');
  const other = message('m2-foreign', '异账号样品 6254', 'foreign');
  message('m2-chatter', '随意闲聊 7428');
  const suspect = suggestions.insert({ messageId: raw, messageIds: [other], title: '混合账号' });
  await f.request('/previews', { kind: 'accept_todo', suggestionId: suspect }, 403);
  const candidate = suggestions.insert({ messageId: raw, title: '提交样品' });
  assert.equal((await f.ask('4481')).status, 'no_evidence');
  const rejected = await f.preview({ kind: 'accept_todo', suggestionId: candidate });
  assert.equal((await f.request('/todos')).items.length, 0);
  await f.decide(rejected, 'reject');
  assert.equal(suggestions.get({ id: candidate, accountRef: owner }).status, 'pending');
  const combined = await f.preview({ kind: 'accept_todo', suggestionId: candidate });
  const receipt = 'combined-m2';
  const result = await f.decide(combined, 'approve', receipt);
  assert.equal(result.admitted, 1);
  assert.deepEqual(await f.decide(combined, 'approve', receipt), result);
  const [id] = result.todoIds;
  assert.equal((await f.request('/todos')).items.length, 1);
  const source = (await f.ask('4481')).evidence[0];
  assert.match((await f.request('/evidence/' + source.id)).quote, /4481/);
  const existing = suggestions.accept({ id: suggestions.insert({ messageId: raw, title: '复核样品' }), accountRef: owner }).todo;
  const second = suggestions.accept({ id: suggestions.insert({ messageId: message('m2-second', '记录仓位 9942'), title: '记录仓位' }), accountRef: owner }).todo;
  assert.equal((await f.ask('9942')).status, 'no_evidence');
  assert.ok((await f.ask('还有什么待办')).evidence.some(item => item.id === 'todo-' + second.id));
  assert.equal((await f.approve({ kind: 'admit_todos', todoIds: [existing.id, second.id] })).admitted, 2);
  suggestions.updateTodo({ id, accountRef: owner, action: 'complete' });
  assert.equal((await f.ask('4481')).evidence[0].id, source.id);
  suggestions.updateTodo({ id: existing.id, accountRef: owner, action: 'delete' });
  assert.equal((await f.ask('4481')).status, 'no_evidence');
  await f.request('/evidence/' + source.id, undefined, 404);
  assert.equal((await f.ask('还有什么待办')).evidence.some(item => item.id === 'todo-' + id), false);
  suggestions.updateTodo({ id, accountRef: owner, action: 'reopen' });
  assert.equal((await f.ask('4481')).evidence[0].id, source.id);
  assert.equal((await f.ask('7428')).status, 'no_evidence');
  assert.ok(messages.get({ id: raw, accountRef: owner }));
});

test('M2 A07: profile approval invalidates old work and new plans require fresh approval', async t => {
  const f = await fixture(t);
  const profiles = require('../src/documents/profile.cjs');
  const tasks = require('../src/db/repositories/tasks.cjs').createTaskRepository(f.db);
  const jobs = require('../src/db/repositories/jobs.cjs').createJobRepository(f.db);
  const { processNextPrepareJob } = require('../src/worker/prepare.cjs');
  const { processNextExecuteJob } = require('../src/worker/execute.cjs');
  const owner = 'fixture-account';
  profiles.saveProfile(f.db, { name: '测试甲', student_id: '0001', age: 20, sex: '示例' });
  profiles.setField(f.db, 'major', '旧专业');
  const task = tasks.create({ accountRef: owner, targetRef: 'https://docs.qq.com/sheet/synthetic' });
  jobs.enqueue({ type: 'prepare_task', payload: { taskId: task.id, accountRef: owner } });
  const grid = [['姓名', '学号', '专业'], ['测试甲', '0001', '']];
  let writes = 0;
  const worker = {
    tasks, jobs, workerId: 'fixture', config: { execute: true },
    fields: () => profiles.fields(f.db),
    createSheet: () => ({
      open: async () => {}, close: async () => {}, readUsedRange: async () => grid,
      applyGeneral: async plan => {
        assert.throws(() => profiles.setField(f.db, 'major', '竞争更新'), /profile_busy/);
        writes++;
        grid[1][2] = plan.changes[0].value;
      },
      verifyGeneral: async () => true
    }),
    analyze: async () => ({ mappings: [{ column: 3, field: 'major' }], confidence: 1, notes: [] })
  };
  function approve(plan) {
    const result = tasks.approve({ taskId: task.id, accountRef: owner, planId: plan.id, planVersion: plan.version,
      planDigest: plan.digest, clientRequestId: randomUUID() });
    jobs.enqueue({ type: 'execute_operation', payload: { taskId: task.id, accountRef: owner, operationId: result.operation.id } });
    return result.operation;
  }
  assert.equal((await processNextPrepareJob(worker)).state, 'awaiting_approval');
  const old = tasks.currentPlan({ taskId: task.id, accountRef: owner });
  assert.equal(JSON.parse(old.plan_json).changes[0].value, '旧专业');
  const pending = await f.preview({ kind: 'profile', key: 'major', value: '新专业' });
  assert.equal(profiles.fields(f.db).major, '旧专业');
  const oldOp = approve(old);
  assert.equal((await f.decide(pending)).state, 'committed');
  assert.equal(tasks.getOperation({ id: oldOp.id, taskId: task.id }).error_class, 'profile_changed');
  assert.throws(() => approve(old), /plan_not_current/);
  assert.equal((await processNextPrepareJob(worker)).state, 'awaiting_approval');
  const fresh = tasks.currentPlan({ taskId: task.id, accountRef: owner });
  assert.equal(JSON.parse(fresh.plan_json).changes[0].value, '新专业');
  assert.notEqual(fresh.digest, old.digest);
  approve(fresh);
  // 新计划已经批准时，排在前面的旧执行任务仍须被跳过。
  assert.equal((await processNextExecuteJob(worker)).skipped, true);
  assert.equal(writes, 0);
  assert.equal((await processNextExecuteJob(worker)).state, 'completed');
  assert.equal(grid[1][2], '新专业');
  assert.equal(writes, 1);
  await f.approve({ kind: 'profile', key: 'sex', value: null });
  assert.equal(Object.hasOwn(profiles.fields(f.db), 'sex'), false);
  assert.equal(f.db.prepare('SELECT sex FROM profile WHERE id=1').get().sex, '示例');
  const legacy = tasks.create({ accountRef: owner, targetRef: 'https://docs.qq.com/sheet/oldplan' });
  tasks.transition({ id: legacy.id, accountRef: owner, event: 'start' });
  const unversioned = tasks.savePlan({ taskId: legacy.id, plan: { changes: [] }, digest: 'fixture-legacy-digest' });
  tasks.transition({ id: legacy.id, accountRef: owner, event: 'ready_for_approval' });
  assert.throws(() => tasks.approve({ taskId: legacy.id, accountRef: owner, planId: unversioned.id, planVersion: unversioned.version,
    planDigest: unversioned.digest, clientRequestId: randomUUID() }), /profile_changed/);
  assert.equal(tasks.get({ id: legacy.id, accountRef: owner }).state, 'preparing');
});

function researchPhase(payload) {
  return /当前阶段 (\w+)/.exec(payload.messages[0].content)?.[1];
}

function researchReply(input, payload, overrides = {}) {
  const phase = researchPhase(payload);
  const id = input.evidence[0].id;
  const defaults = {
    explore: { answer: '独立结论 7316', citations: [id], gaps: ['还需评审'] },
    review: { claim_id: input.shared[0]?.id, finding: '区分样本和结论', evidence_ids: [id],
      severity: 'medium', proposed_revision: '明确只覆盖当前样本' },
    synthesize: { answer: '汇总报告 7316，仅覆盖当前样本', citations: [id], disagreements: ['样本范围有限'] },
    assess: { preferred: 'new', reason: '引用正确且边界清楚', complete: true }
  };
  return Response.json({ choices: [{ message: { content: JSON.stringify({ ...defaults[phase], ...overrides }) } }],
    usage: { total_tokens: 23 } });
}

async function researchSource(f) {
  fs.writeFileSync(path.join(f.source, 'research.md'), '合成研究标记 7316，只覆盖当前样本。');
  await f.approve({ kind: 'import', rootId: f.root, names: ['research.md'] });
  return (await f.request('/knowledge')).items[0].id;
}

const researchAgents = count => Array.from({ length: count }, (_, i) => ({
  id: 'agent-' + (i + 1), modelId: i % 2 ? 'fixture-review' : 'fixture'
}));

async function researchWait(f, id, condition = state => state.state !== 'running') {
  const end = Date.now() + 30000;
  do {
    const state = await f.request('/research/' + id);
    if (condition(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < end);
  throw Error('research_timeout');
}

test('M3 A09 A10 A14: independent agents discuss, retain the better result and save only by approval', async t => {
  let reports = 0;
  const trace = [];
  const f = await fixture(t, { liveModel: false, modelReply(input, payload) {
    const phase = researchPhase(payload);
    trace.push({ phase, input, model: payload.model });
    if (phase === 'synthesize') {
      reports++;
      return researchReply(input, payload, { answer: reports === 1 ? '第一份较优报告' : '第二份较弱报告' });
    }
    if (phase === 'assess') return researchReply(input, payload, { preferred: reports === 1 ? 'new' : 'previous', complete: reports >= 2 });
    return researchReply(input, payload);
  } });
  const doc = await researchSource(f);
  const input = { clientRequestId: randomUUID(), question: '比较这个样本', sourceIds: [doc], effort: { preset: 'medium' } };
  await f.request('/research', { ...input, agents: researchAgents(5) }, 400);
  await f.request('/research', input, 403);
  assert.equal(trace.length, 0);
  await f.approve({ kind: 'cloud_grant', documentId: doc });
  const opened = await f.request('/research', input, 202);
  assert.equal(opened.agents.length, 2);
  assert.notEqual(opened.agents[0].prompt, opened.agents[1].prompt);
  assert.equal((await f.request('/research', input, 202)).id, opened.id);
  const finished = await researchWait(f, opened.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.result.answer, '第一份较优报告');
  assert.equal(finished.budget.calls, 12);
  assert.equal(finished.budget.tokens, 276);
  assert.equal(trace[0].input.history.length, 0);
  assert.equal(trace[1].input.history.length, 0);
  assert.deepEqual(trace.slice(0, 2).map(entry => entry.input.shared.length), [0, 0]);
  assert.deepEqual(trace.slice(2, 4).map(entry => entry.input.shared[0].agentId), ['agent-2', 'agent-1']);
  assert.deepEqual(trace.slice(0, 2).map(entry => entry.model), ['deepseek-chat', 'deepseek-chat']);
  const history = await f.request('/research/' + opened.id + '/artifacts');
  assert.ok(history.items.some(entry => entry.phase === 'synthesize' && entry.data.answer === '第二份较弱报告'));
  assert.ok((await f.request('/events?resourceId=' + opened.id)).items.some(item => item.type === 'artifact'));
  assert.equal((await f.request('/research')).items[0].id, opened.id);
  assert.equal(fs.readdirSync(path.join(f.storage, 'objects')).length, 1);

  const save = await f.request('/research/' + opened.id + '/save-preview', { name: '合成报告.md', includeProcess: true }, 201);
  assert.match(save.details.rows[0].text, /第一份较优报告/);
  await f.decide(save, 'reject');
  assert.equal(fs.readdirSync(path.join(f.storage, 'objects')).length, 1);
  const approved = await f.request('/research/' + opened.id + '/save-preview', { name: '合成报告.md' }, 201);
  assert.equal((await f.decide(approved)).state, 'committed');
  assert.equal(fs.readdirSync(path.join(f.storage, 'objects')).length, 2);

  const four = await f.request('/research', { ...input, clientRequestId: randomUUID(), agents: researchAgents(4), effort: { preset: 'low' } }, 202);
  const result = await researchWait(f, four.id);
  assert.equal(result.agents.length, 4);
  assert.equal(result.budget.calls, 9);
  assert.equal(result.budget.rounds, 1);
  const firstFour = trace.slice(12, 16);
  assert.ok(firstFour.every(entry => entry.phase === 'explore' && !entry.input.shared.length));
  assert.ok(firstFour.some(entry => entry.model === 'fixture-review-model'));
  await f.request('/research/' + opened.id + '/close', {});
  await f.request('/research/' + opened.id, undefined, 410);
  f.restart();
  assert.equal((await f.request('/research')).items.length, 0);
  await f.request('/research/' + four.id, undefined, 410);
  assert.equal((await f.request('/knowledge')).items.length, 2);
});

test('M3 A11: independent budget limits, concurrent reservations and paused time', () => {
  const { createBudget } = require('../src/research/budget.cjs');
  let now = 0;
  const limits = { tokens: 900, calls: 2, rounds: 1, activeMs: 100 };
  const budget = createBudget(limits, () => now);
  const messages = [{ content: 'fixture' }];
  budget.start();
  assert.equal(budget.newRound(), null);
  const first = budget.reserve(messages, 300, 1000, 32768);
  assert.ok(first.amount);
  assert.equal(budget.reserve(messages, 300, 1000, 32768).stop, 'tokens');
  budget.settle(first, 20);
  const second = budget.reserve(messages, 300, 1000, 32768);
  assert.ok(second.amount);
  assert.equal(budget.reserve(messages, 300, 1000, 32768).stop, 'calls');
  budget.settle(second, null);
  assert.equal(budget.snapshot().estimatedCalls, 1);
  budget.increase({ calls: 3 });
  assert.equal(budget.newRound(), 'rounds');
  now = 40;
  budget.pause();
  now = 600;
  budget.start();
  now = 660;
  assert.equal(budget.reserve(messages, 300, 1000, 32768).stop, 'time');
  assert.equal(budget.snapshot().activeMs, 100);
  const over = createBudget(limits);
  over.start();
  const reserved = over.reserve(messages, 100, 1000, 32768);
  over.settle(reserved, reserved.amount + 1);
  assert.equal(over.reserve(messages, 100, 1000, 32768).stop, 'usage_overrun');
  assert.equal(over.snapshot().excessTokens, 1);
});

test('M3 A11 A12: pause fences late responses, updates use remaining budget, and cancellation stops dispatch', async t => {
  let release;
  let started = false;
  let resumed;
  const f = await fixture(t, { liveModel: false, modelReply(input, payload) {
    if (!started) {
      started = true;
      return new Promise(resolve => { release = () => resolve(researchReply(input, payload)); });
    }
    resumed = input;
    return researchReply(input, payload);
  } });
  const doc = await researchSource(f);
  await f.approve({ kind: 'cloud_grant', documentId: doc });
  const opened = await f.request('/research', { clientRequestId: randomUUID(), question: '核对样本', sourceIds: [doc],
    effort: { preset: 'custom', limits: { tokens: 36000, calls: 1, rounds: 1, activeMs: 5000 } } }, 202);
  const running = await researchWait(f, opened.id, state => state.budget.calls === 1);
  assert.ok(started);
  const control = (state, action, input) => f.request('/research/' + opened.id + '/control', {
    action, input, expectedVersion: state.version, clientRequestId: randomUUID()
  });
  const paused = await control(running, 'pause');
  const updated = await control(paused, 'add_requirement', { requirement: '解释样本边界' });
  const pausedMs = updated.budget.activeMs;
  release(); // 模拟供应商已经收到调用，取消后仍返回回执。
  const settled = await researchWait(f, opened.id, state => state.budget.reserved === 0);
  assert.equal(settled.budget.activeMs, pausedMs);
  assert.equal(settled.budget.calls, 1);
  assert.equal(settled.result, null);
  assert.equal((await f.request('/research/' + opened.id + '/artifacts')).items.length, 0);
  await control(settled, 'resume');
  const exhausted = await researchWait(f, opened.id);
  assert.equal(exhausted.reason, 'calls');
  await control(exhausted, 'increase_budget', { limits: { calls: 2 } });
  const again = await researchWait(f, opened.id);
  assert.equal(again.budget.calls, 2);
  assert.equal(again.budget.rounds, 1);
  assert.equal(resumed.requirements[0].text, '解释样本边界');
  assert.ok(again.result.provisional);
  const stopped = await control(again, 'cancel');
  assert.equal(stopped.state, 'cancelled');
  assert.equal(stopped.budget.calls, 2);
  const newTopic = await f.request('/research', { clientRequestId: randomUUID(), question: '另一道样本问题', sourceIds: [doc] }, 202);
  assert.notEqual(newTopic.id, opened.id);
  await researchWait(f, newTopic.id);
  assert.equal((await f.request('/research')).items.length, 2);
});

test('M3 A12: model failures keep configured identities and authorized sources can be revoked', async t => {
  let failAll = false;
  let hold = false;
  let release;
  const f = await fixture(t, { liveModel: false, modelReply(input, payload) {
    if (hold) return new Promise(resolve => { release = () => resolve(researchReply(input, payload)); });
    if (failAll || payload.model === 'deepseek-chat') return new Response('{}', { status: 503 });
    return researchReply(input, payload);
  } });
  const doc = await researchSource(f);
  await f.approve({ kind: 'cloud_grant', documentId: doc });
  async function start() {
    return f.request('/research', { clientRequestId: randomUUID(), question: '核对样本', sourceIds: [doc], agents: researchAgents(2) }, 202);
  }
  const first = await researchWait(f, (await start()).id);
  assert.equal(first.state, 'partial');
  assert.equal(first.summarizer, 'agent-2');
  assert.deepEqual(first.failed, [{ agentId: 'agent-1', code: 'model_failed' }]);
  failAll = true;
  const failed = await researchWait(f, (await start()).id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failed.length, 2);
  hold = true;
  const third = await f.request('/research', { clientRequestId: randomUUID(), question: '核对样本', sourceIds: [doc],
    effort: { preset: 'custom', limits: { tokens: 36000, calls: 1, rounds: 1, activeMs: 5000 } } }, 202);
  await researchWait(f, third.id, state => state.budget.calls === 1);
  await f.approve({ kind: 'cloud_revoke', documentId: doc });
  release();
  const revoked = await researchWait(f, third.id, state => state.budget.reserved === 0);
  assert.equal(revoked.state, 'paused');
  assert.equal(revoked.reason, 'source_changed');
  assert.equal(revoked.result, null);
  await f.request('/research/' + third.id + '/control', { action: 'resume', expectedVersion: revoked.version, clientRequestId: randomUUID() }, 409);
});

test('M3 live: two configured Agents exchange evidence and produce a report',
  { skip: process.env.LAB1_RESEARCH_LIVE_FIXTURE !== '1', timeout: 60000 }, async t => {
    const f = await fixture(t, { liveModel: true, outputLimit: 768 });
    const doc = await researchSource(f);
    await f.approve({ kind: 'cloud_grant', documentId: doc });
    const opened = await f.request('/research', { clientRequestId: randomUUID(), sourceIds: [doc], agents: researchAgents(2),
      question: '根据合成资料回答研究标记是什么，以及这条资料可以支持多大范围的结论？' }, 202);
    const task = await researchWait(f, opened.id);
    const { items } = await f.request('/research/' + opened.id + '/artifacts');
    for (const phase of ['explore', 'review', 'synthesize', 'assess']) {
      assert.ok(items.some(item => item.phase === phase), phase + ': ' + task.state);
    }
    assert.equal(task.failed.length, 0);
    assert.ok(task.result.evidence.length);
    assert.match(task.result.answer, /7316/);
    assert.ok(task.budget.tokens > 0);
    t.diagnostic(JSON.stringify({ state: task.state, calls: task.budget.calls, tokens: task.budget.tokens, phaseCount: 4 }));
  });
