const path = require('node:path');
const { spawn } = require('node:child_process');

const modules = new Set(['campusdesk.messages', 'campusdesk.tools']);
let inFlight = 0;

function invokePolicy(moduleName, input, signal) {
  if (!modules.has(moduleName)) return Promise.reject(Error('policy_unavailable'));
  if (inFlight >= 16) return Promise.reject(Object.assign(Error('policy_busy'), { status: 429 }));
  if (signal?.aborted) return Promise.reject(Error('cancelled'));
  inFlight++;
  return new Promise((resolve, reject) => {
    const python = process.env.CAMPUS_DESK_PYTHON || 'python';
    const child = spawn(python, ['-m', moduleName], {
      cwd: path.resolve(__dirname, '../..'), windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PYTHONIOENCODING: 'utf-8' }
    });
    let stdout = '';
    const stop = () => child.kill();
    const timer = setTimeout(stop, 5000);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 8192) stop();
    });
    child.stdin.on('error', () => {});
    child.once('error', () => reject(Error('policy_unavailable')));
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      inFlight--;
      if (signal?.aborted) return reject(Error('cancelled'));
      if (code !== 0) return reject(Error('policy_unavailable'));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(Error('policy_unavailable')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

module.exports = { invokePolicy };
