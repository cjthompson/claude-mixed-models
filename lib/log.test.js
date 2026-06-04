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
      user: 'alice',
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
    '[01:23:45 REQ 4f7a9b2c] method=POST url=/v1/messages model=claude-minimax route=MiniMax-M3 upstream=minimax user=alice',
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
      usage: { input_tokens: 1234, output_tokens: 42, cache_read_input_tokens: 5678, cache_creation_input_tokens: 120, total_tokens: 7000 },
    });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  assert.deepEqual(captured, [
    '[01:23:46 RES 4f7a9b2c] upstream=minimax status=200 duration=842ms input=1234 output=42 cache_read=5678 cache_write=120 total=7000',
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

test('logRes: omits absent fields within a usage object', () => {
  stubNow('01:23:46');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logRes('id', {
      upstream: 'minimax',
      status: 200,
      durationMs: 50,
      usage: { input_tokens: 100, output_tokens: 5 },
    });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  assert.deepEqual(captured, [
    '[01:23:46 RES id] upstream=minimax status=200 duration=50ms input=100 output=5',
  ]);
});

// --- colorBracket via logReq / logRes --------------------------------------
test('logReq: emits ANSI color around bracket when session is present', () => {
  const origNow = log.__setNowForTest(() => '01:23:45');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logReq('aabbccdd', {
      method: 'POST',
      url: '/v1/messages',
      upstream: 'minimax',
      session: 'abc12345',
    });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  const line = captured[0];
  assert.ok(line.startsWith('\x1b['), `expected ESC[ at start, got: ${JSON.stringify(line)}`);
  assert.ok(line.includes('[01:23:45 REQ aabbccdd]'), `expected bracket text: ${JSON.stringify(line)}`);
  const bracketEnd = line.indexOf('[01:23:45 REQ aabbccdd]') + '[01:23:45 REQ aabbccdd]'.length;
  const afterBracket = line.slice(0, bracketEnd + 10);
  assert.ok(afterBracket.includes('\x1b[0m'), `expected reset code after bracket: ${JSON.stringify(line)}`);
  assert.ok(line.includes('method=POST'), `expected fields after bracket: ${JSON.stringify(line)}`);
  assert.ok(!line.includes('session='), `session must not appear as a field: ${JSON.stringify(line)}`);
});

test('logRes: bracket color matches logReq for the same session_id', () => {
  const origNow = log.__setNowForTest(() => '01:23:45');
  const capturedReq = [];
  const capturedRes = [];
  const orig = console.log;
  try {
    console.log = (line) => capturedReq.push(line);
    logReq('aabbccdd', { method: 'POST', url: '/v1/messages', upstream: 'minimax', session: 'abc12345' });
    console.log = (line) => capturedRes.push(line);
    logRes('aabbccdd', { upstream: 'minimax', status: 200, durationMs: 5, usage: null, session: 'abc12345' });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  function escPrefix(line) {
    const m = line.match(/^(\x1b\[[^m]*m)/);
    return m ? m[1] : '';
  }

  const reqPrefix = escPrefix(capturedReq[0]);
  const resPrefix = escPrefix(capturedRes[0]);
  assert.ok(reqPrefix.length > 0, `REQ line should have an escape prefix: ${JSON.stringify(capturedReq[0])}`);
  assert.equal(reqPrefix, resPrefix, 'REQ and RES for the same session_id must use the same color');
});

test('logReq: no color when session is absent', () => {
  const origNow = log.__setNowForTest(() => '01:23:45');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logReq('aabbccdd', {
      method: 'POST',
      url: '/v1/messages',
      upstream: 'minimax',
    });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  const line = captured[0];
  assert.ok(!line.includes('\x1b['), `expected no ESC codes when session is absent: ${JSON.stringify(line)}`);
});

// --- sessionIdFromUserId ---------------------------------------------------
// Claude Code sends metadata.user_id as a JSON-stringified object. Other
// clients (or older versions) send it as a nested object. The helper must
// handle both shapes, plus the absent/null/non-JSON fallbacks.

test('sessionIdFromUserId: extracts session_id from a stringified JSON object', () => {
  const userId = JSON.stringify({ device_id: 'abc', session_id: '554e208e-9c8e-483d-ba28-c8a9222971f8' });
  assert.equal(log.sessionIdFromUserId(userId), '554e208e-9c8e-483d-ba28-c8a9222971f8');
});

test('sessionIdFromUserId: extracts session_id from a nested object', () => {
  const userId = { device_id: 'abc', session_id: 'abc12345' };
  assert.equal(log.sessionIdFromUserId(userId), 'abc12345');
});

test('sessionIdFromUserId: returns undefined when user_id is null/undefined', () => {
  assert.equal(log.sessionIdFromUserId(null), undefined);
  assert.equal(log.sessionIdFromUserId(undefined), undefined);
});

test('sessionIdFromUserId: returns undefined when user_id is a plain string', () => {
  assert.equal(log.sessionIdFromUserId('alice'), undefined);
});

test('sessionIdFromUserId: returns undefined when user_id is malformed JSON', () => {
  assert.equal(log.sessionIdFromUserId('{not json'), undefined);
});

test('sessionIdFromUserId: returns undefined when user_id has no session_id', () => {
  assert.equal(log.sessionIdFromUserId(JSON.stringify({ device_id: 'abc' })), undefined);
  assert.equal(log.sessionIdFromUserId({ device_id: 'abc' }), undefined);
});

// --- abbrev ----------------------------------------------------------------

test('abbrev: returns raw integer below 1000', () => {
  assert.equal(log.__abbrev(0), '0');
  assert.equal(log.__abbrev(1), '1');
  assert.equal(log.__abbrev(42), '42');
  assert.equal(log.__abbrev(842), '842');
  assert.equal(log.__abbrev(999), '999');
});

test('abbrev: formats 1000-9999 with one decimal when needed', () => {
  assert.equal(log.__abbrev(1000), '1k');
  assert.equal(log.__abbrev(1234), '1.2k');
  assert.equal(log.__abbrev(2000), '2k');
  assert.equal(log.__abbrev(9999), '10k');
});

test('abbrev: 10000-999999 uses one decimal, capped at 3 digits', () => {
  assert.equal(log.__abbrev(10000), '10k');
  assert.equal(log.__abbrev(10234), '10.2k');
  assert.equal(log.__abbrev(100000), '100k');
  assert.equal(log.__abbrev(999999), '1M');     // rounds up to 1000k → 1M
});

test('abbrev: formats 1M and above with one decimal when needed', () => {
  assert.equal(log.__abbrev(1_000_000), '1M');
  assert.equal(log.__abbrev(1_500_000), '1.5M');
  assert.equal(log.__abbrev(2_000_000), '2M');
});

test('abbrev: negative numbers pass through unchanged', () => {
  assert.equal(log.__abbrev(-5), '-5');
});
