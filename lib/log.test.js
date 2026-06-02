import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as log from './log.js';
import { newRequestId, timestamp, logReq, logRes } from './log.js';

// --- newRequestId ----------------------------------------------------------

test('newRequestId: returns 8 lowercase hex chars', () => {
  const id = newRequestId();
  assert.match(id, /^[0-9a-f]{8}$/);
});

test('newRequestId: two calls return different ids', () => {
  const a = newRequestId();
  const b = newRequestId();
  assert.notEqual(a, b);
});

// --- timestamp -------------------------------------------------------------

test('timestamp: returns HH:MM:SS in 24h format', () => {
  assert.match(timestamp(), /^\d{2}:\d{2}:\d{2}$/);
});

// --- logReq ----------------------------------------------------------------
// We stub the internal clock (via __setNowForTest) so the assertions can be
// exact. logReq/logRes read time through a module-local `now` indirection
// (rather than calling timestamp() directly) because ES module namespace
// objects are sealed in Node and cannot be monkey-patched. The namespace
// import is still useful for asserting structure and reaching the seam.

const origNow = timestamp;
function stubNow(value) {
  log.__setNowForTest(() => value);
}

test('logReq: emits fields in the documented order, omitting absent ones', () => {
  stubNow('01:23:45');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logReq('4f7a9b2c', {
      method: 'POST',
      url: '/v1/messages',
      model: 'claude-minimax',
      route: 'MiniMax-M3',
      upstream: 'minimax',
      user: 'chris',
    });
    logReq('aaaaaaaaaaaaaaaa', {
      method: 'GET',
      url: '/v1/models',
      upstream: 'api.anthropic.com',
    });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  assert.deepEqual(captured, [
    '[01:23:45 REQ 4f7a9b2c] method=POST url=/v1/messages model=claude-minimax route=MiniMax-M3 upstream=minimax user=chris',
    '[01:23:45 REQ aaaaaaaaaaaaaaaa] method=GET url=/v1/models upstream=api.anthropic.com',
  ]);
});

test('logReq: omits fields whose value is undefined or null', () => {
  stubNow('01:23:45');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logReq('id', {
      method: 'POST',
      url: '/x',
      upstream: 'minimax',
      model: undefined,
      route: null,
      user: undefined,
    });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  assert.deepEqual(captured, [
    '[01:23:45 REQ id] method=POST url=/x upstream=minimax',
  ]);
});

// --- logRes ----------------------------------------------------------------

test('logRes: emits fields in the documented order, omitting absent ones', () => {
  stubNow('01:23:46');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logRes('4f7a9b2c', {
      upstream: 'minimax',
      status: 200,
      durationMs: 842,
      usage: { input_tokens: 1234, output_tokens: 42, cache_read_input_tokens: 5678, cache_creation_input_tokens: 120 },
    });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  assert.deepEqual(captured, [
    '[01:23:46 RES 4f7a9b2c] upstream=minimax status=200 duration=842ms input=1234 output=42 cache_read=5678 cache_write=120',
  ]);
});

test('logRes: works without usage (router case — no usage captured)', () => {
  stubNow('01:23:46');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logRes('id', { upstream: 'minimax', status: 200, durationMs: 5, usage: null });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  assert.deepEqual(captured, [
    '[01:23:46 RES id] upstream=minimax status=200 duration=5ms',
  ]);
});

test('logRes: handles non-200 status with no usage', () => {
  stubNow('01:23:46');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logRes('id', { upstream: 'minimax', status: 502, durationMs: 1234, usage: null });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  assert.deepEqual(captured, [
    '[01:23:46 RES id] upstream=minimax status=502 duration=1234ms',
  ]);
});
