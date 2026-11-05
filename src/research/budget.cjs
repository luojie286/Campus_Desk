const { fail } = require('../knowledge/files.cjs');

const presets = Object.freeze({
  low: Object.freeze({ tokens: 36000, calls: 9, rounds: 1, activeMs: 300000 }),
  medium: Object.freeze({ tokens: 100000, calls: 27, rounds: 3, activeMs: 900000 }),
  high: Object.freeze({ tokens: 200000, calls: 54, rounds: 6, activeMs: 1800000 })
});
const ceilings = { tokens: 1000000, calls: 100, rounds: 12, activeMs: 3600000 };

function readLimits(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(ceilings, key))) fail('invalid_budget');
  const output = {};
  for (const [key, cap] of Object.entries(ceilings)) {
    const value = input[key] ?? previous?.[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) fail('invalid_budget');
    output[key] = value;
  }
  return output;
}

function effortLimits(effort = { preset: 'low' }) {
  if (effort?.preset === 'custom') return readLimits(effort.limits);
  if (!Object.hasOwn(presets, effort?.preset)) fail('invalid_budget');
  return readLimits(effort.limits ?? {}, presets[effort.preset]);
}

function createBudget(limits, now = () => performance.now()) {
  let elapsed = 0;
  let started = null;
  let calls = 0, rounds = 0, tokens = 0, reserved = 0, estimatedCalls = 0, excessTokens = 0;
  let overrun = false;
  function activeMs() { return elapsed + (started === null ? 0 : now() - started); }
  function stopReason() {
    if (overrun) return 'usage_overrun';
    if (activeMs() >= limits.activeMs) return 'time';
    if (calls >= limits.calls) return 'calls';
    if (tokens + reserved >= limits.tokens) return 'tokens';
    return null;
  }
  return {
    snapshot: () => ({ limits: { ...limits }, calls, rounds, tokens, reserved, estimatedCalls, excessTokens, overrun, activeMs: Math.floor(activeMs()) }),
    start() { if (started === null) started = now(); },
    pause() { elapsed = activeMs(); started = null; },
    newRound() {
      const stop = stopReason() || (rounds >= limits.rounds ? 'rounds' : null);
      if (stop) return stop;
      rounds++;
      return null;
    },
    reserve(messages, output, timeout, context) {
      const stop = stopReason();
      if (stop) return { stop };
      // 使用 UTF-8 字节数和消息封装余量做保守估算。实际账单以供应商回执为准。
      const input = 256 + messages.reduce((sum, item) => sum + Buffer.byteLength(item.content) + 64, 0);
      if (input >= context) return { stop: 'context_limit' };
      const maxOutput = Math.min(output, context - input, limits.tokens - tokens - reserved - input);
      if (maxOutput < 1) return { stop: 'tokens' };
      const amount = input + maxOutput;
      calls++;
      reserved += amount;
      return { amount, maxOutput, timeout: Math.max(1, Math.min(timeout, Math.floor(limits.activeMs - activeMs()))) };
    },
    settle(reservation, usage) {
      reserved -= reservation.amount;
      const actual = Number.isSafeInteger(usage) && usage >= 0;
      tokens += actual ? usage : reservation.amount;
      if (!actual) estimatedCalls++;
      if (actual && usage > reservation.amount) {
        excessTokens += usage - reservation.amount;
        overrun = true;
      }
    },
    increase(input) {
      const next = readLimits(input, limits);
      if (Object.keys(limits).some(key => next[key] < limits[key]) ||
          !Object.keys(limits).some(key => next[key] > limits[key]) || next.tokens < tokens + reserved) fail('invalid_budget');
      limits = next;
      overrun = false;
    }
  };
}

module.exports = { presets, effortLimits, createBudget };
