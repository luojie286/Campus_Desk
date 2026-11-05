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

async function fixture(t, { externalTrash = false } = {}) {
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
    endpoint: 'https://api.deepseek.com/chat/completions', output: 256, timeout: 30000 };
  const config = { db, owner: 'fixture-account', storage: fs.realpathSync(storage), trashRoot,
    languagePath: path.resolve('.private/ocr'), token, models: [model], port, profileFixture: true };
  const previous = process.env.LAB1_ASSISTANT_MOCK_TOKEN;
  process.env.LAB1_ASSISTANT_MOCK_TOKEN = 'fixture';
  if (!live) {
    model.credential = 'LAB1_ASSISTANT_MOCK_TOKEN';
    config.fetchModel = async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      calls.push(input);
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
  return { folder, source, storage, trashRoot, db, request, root, preview, decide, approve, ask, calls, base: 'http://127.0.0.1:' + port + '/v1/assistant' };
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
  assert.equal((await f.request('/fixture-fields/fixture_field')).value, null);
  await f.decide(add);
  assert.equal((await f.request('/fixture-fields/fixture_field')).value, '甲');
  await f.approve({ kind: 'profile', key: 'fixture_field', value: '乙' });
  assert.equal((await f.request('/fixture-fields/fixture_field')).value, '乙');
  await f.approve({ kind: 'profile', key: 'fixture_field', value: null });
  assert.equal((await f.request('/fixture-fields/fixture_field')).value, null);

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
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.source, '本机验收.md'), '信号标记 8136');
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
    const page = await browser.newPage();
    await page.route('**/api/v1/assistant/**', async route => {
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
    });
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
  });
