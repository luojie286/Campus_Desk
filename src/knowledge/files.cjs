const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_BYTES = 32 * 1024 * 1024;
const extensions = new Set(['.md', '.txt', '.pdf', '.docx', '.png', '.jpg', '.jpeg']);
const hash = value => createHash('sha256').update(value).digest('hex');

function fail(code, status = 400) {
  throw Object.assign(new Error(code), { status });
}

function relativeName(value) {
  if (typeof value !== 'string' || value.length > 1024) fail('invalid_path');
  const parts = value.replaceAll('\\', '/').split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]|[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail('invalid_path');
  }
  return parts.join('/');
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function checkedAbsolute(value) {
  if (typeof value !== 'string' || value.length > 1024 || !path.isAbsolute(value) ||
      /^\\\\/.test(value) || /[<>:"|?*\x00-\x1f]/.test(value.slice(path.parse(value).root.length))) {
    fail('invalid_path');
  }
  const result = path.resolve(value);
  const base = path.parse(result).root;
  const rest = path.relative(base, result);
  if (!rest) fail('invalid_path');
  relativeName(rest);
  let next = base;
  // 每一级都检查 junction。仅检查最终 realpath 无法区分被改指的授权根。
  for (const part of rest.split(path.sep)) {
    next = path.join(next, part);
    if (fs.lstatSync(next).isSymbolicLink()) fail('outside_scope', 403);
  }
  return fs.realpathSync(result);
}

function resolveSource(root, name, { missing = false } = {}) {
  name = relativeName(name);
  const base = checkedAbsolute(root.path);
  if (path.relative(root.path, base)) fail('outside_scope', 403);
  const target = root.kind === 'file' ? base : path.join(base, ...name.split('/'));
  if (root.kind === 'file' && path.basename(base) !== name) fail('outside_scope', 403);
  const checked = missing && !fs.existsSync(target)
    ? path.join(checkedAbsolute(path.dirname(target)), path.basename(target))
    : checkedAbsolute(target);
  if (!within(base, checked) || path.relative(target, checked)) fail('outside_scope', 403);
  return checked;
}

function readFile(target) {
  if (path.relative(target, checkedAbsolute(target))) fail('outside_scope', 403);
  const handle = fs.openSync(target, 'r');
  try {
    const before = fs.fstatSync(handle);
    if (!before.isFile()) fail('unsupported_document', 422);
    if (before.size > MAX_BYTES) fail('too_large', 413);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const size = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (!size) fail('preview_changed', 409);
      offset += size;
    }
    const after = fs.fstatSync(handle);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('preview_changed', 409);
    return { bytes, digest: hash(bytes) };
  } finally {
    fs.closeSync(handle);
  }
}

function checkFormat(name) {
  if (!extensions.has(path.extname(name).toLowerCase())) fail('unsupported_document', 422);
}

// Staging and publication share a volume. A hard link reserves the name without overwriting.
function publish(target, bytes, digest) {
  const stage = target + '.partial';
  if (fs.existsSync(target)) {
    if (checkedAbsolute(target) !== target || readFile(target).digest !== digest) fail('preview_changed', 409);
    if (fs.existsSync(stage) && readFile(stage).digest === digest) fs.unlinkSync(stage);
    return;
  }
  if (!fs.existsSync(stage)) {
    const descriptor = fs.openSync(stage, 'wx');
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  if (checkedAbsolute(stage) !== stage || readFile(stage).digest !== digest) fail('preview_changed', 409);
  fs.linkSync(stage, target);
  fs.unlinkSync(stage);
}

module.exports = { MAX_BYTES, hash, fail, relativeName, within, checkedAbsolute, resolveSource, readFile, checkFormat, publish };
