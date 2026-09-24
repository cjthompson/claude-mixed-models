import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as log from './log.js';
import { timestamp } from './log.js';
import { logger } from './logger.js';

// Save and restore LOG_LEVEL/DEBUG and console.log/console.error around fn().
// Restores each env var to its prior value; deletes only if originally unset.
function withEnv(env, fn) {
  const saved = { LOG_LEVEL: process.env.LOG_LEVEL, DEBUG: process.env.DEBUG };
  const out = [], err = [];
  const origLog = console.log, origErr = console.error;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try { fn(); } finally {
    console.log = origLog; console.error = origErr;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return { out, err };
}

function emitAll() {
  logger.debug('d'); logger.info('i'); logger.warn('w'); logger.error('e');
}

// 1
test('default (unset LOG_LEVEL/DEBUG): info/warn/error emitted, debug suppressed', () => {
  const { out, err } = withEnv({ LOG_LEVEL: undefined, DEBUG: undefined }, emitAll);
  assert.deepEqual(out, ['i']);
  assert.deepEqual(err, ['w', 'e']);
});

// 2
const inclusive = {
  debug: { out: ['d', 'i'], err: ['w', 'e'] },
  info:  { out: ['i'],      err: ['w', 'e'] },
  warn:  { out: [],         err: ['w', 'e'] },
  error: { out: [],         err: ['e'] },
};
for (const [level, expected] of Object.entries(inclusive)) {
  test(`LOG_LEVEL=${level}: emits the inclusive set`, () => {
    const { out, err } = withEnv({ LOG_LEVEL: level, DEBUG: undefined }, emitAll);
    assert.deepEqual(out, expected.out);
    assert.deepEqual(err, expected.err);
  });
}

// 3
test('sink routing: debug/info -> console.log, warn/error -> console.error', () => {
  const { out, err } = withEnv({ LOG_LEVEL: 'debug', DEBUG: undefined }, emitAll);
  assert.deepEqual(out, ['d', 'i']);
  assert.deepEqual(err, ['w', 'e']);
});

// 4
test('DEBUG=1 overrides LOG_LEVEL=error', () => {
  const { out, err } = withEnv({ LOG_LEVEL: 'error', DEBUG: '1' }, emitAll);
  assert.deepEqual(out, ['d', 'i']);
  assert.deepEqual(err, ['w', 'e']);
});

// 5
test("DEBUG='' is treated as unset", () => {
  const { out, err } = withEnv({ LOG_LEVEL: 'error', DEBUG: '' }, emitAll);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ['e']);
});

// 6
test("LOG_LEVEL=' DEBUG ' is trimmed and case-insensitive", () => {
  const { out, err } = withEnv({ LOG_LEVEL: ' DEBUG ', DEBUG: undefined }, emitAll);
  assert.deepEqual(out, ['d', 'i']);
  assert.deepEqual(err, ['w', 'e']);
});

// 7
test('LOG_LEVEL=bogus falls back to info', () => {
  const { out, err } = withEnv({ LOG_LEVEL: 'bogus', DEBUG: undefined }, emitAll);
  assert.deepEqual(out, ['i']);
  assert.deepEqual(err, ['w', 'e']);
});

// 7b — inherited Object.prototype keys are not levels
for (const value of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
  test(`LOG_LEVEL=${value} (prototype key) falls back to info`, () => {
    const { out, err } = withEnv({ LOG_LEVEL: value, DEBUG: undefined }, emitAll);
    assert.deepEqual(out, ['i']);
    assert.deepEqual(err, ['w', 'e']);
  });
}

// 8
for (const value of ['silent', 'none', 'off']) {
  test(`LOG_LEVEL=${value}: debug/info/warn/error all suppressed`, () => {
    const { out, err } = withEnv({ LOG_LEVEL: value, DEBUG: undefined }, emitAll);
    assert.deepEqual(out, []);
    assert.deepEqual(err, []);
  });
}

// 9
function emitReqRes(id) {
  logger.req(id, { upstream: 'minimax' });
  logger.res(id, { upstream: 'minimax', status: 200, durationMs: 5, usage: null });
}

for (const level of ['debug', 'info', 'warn', 'error']) {
  test(`logger.req/res emitted at LOG_LEVEL=${level}`, () => {
    log.__setNowForTest(() => '01:23:45');
    let captured;
    try {
      captured = withEnv({ LOG_LEVEL: level, DEBUG: undefined }, () => emitReqRes('4f7a9b2c'));
    } finally {
      log.__setNowForTest(timestamp);
    }
    const { out } = captured;
    assert.ok(out.some((l) => l.includes('[01:23:45 REQ 4f7a9b2c]')), `expected REQ marker, got ${JSON.stringify(out)}`);
    assert.ok(out.some((l) => l.includes('[01:23:45 RES 4f7a9b2c]')), `expected RES marker, got ${JSON.stringify(out)}`);
  });
}

for (const value of ['silent', 'none', 'off']) {
  test(`logger.req/res suppressed at LOG_LEVEL=${value}`, () => {
    const { out, err } = withEnv({ LOG_LEVEL: value, DEBUG: undefined }, () => emitReqRes('id'));
    assert.deepEqual(out, []);
    assert.deepEqual(err, []);
  });
}

// 10
test('multiple arguments are forwarded to the sink', () => {
  const calls = [];
  const saved = { LOG_LEVEL: process.env.LOG_LEVEL, DEBUG: process.env.DEBUG };
  const origErr = console.error;
  delete process.env.LOG_LEVEL; delete process.env.DEBUG;
  console.error = (...a) => calls.push(a);
  try { logger.error('a', 'b'); } finally {
    console.error = origErr;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  assert.deepEqual(calls, [['a', 'b']]);
});