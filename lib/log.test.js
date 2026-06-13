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

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (line) => lines.push(line);
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test('logReq: emits model and upstream; model value is color-wrapped', () => {
  stubNow('01:23:45');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logReq('4f7a9b2c', {
      model: 'minimax',
      upstream: 'minimax',
    });
    logReq('aaaaaaaaaaaaaaaa', {
      upstream: 'api.anthropic.com',
    });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  const modelEsc = log.__colorEscapeForModel('minimax');
  const reset = '\x1b[0m';
  assert.deepEqual(captured, [
    `[01:23:45 REQ 4f7a9b2c] model=${modelEsc}minimax${reset} upstream=minimax`,
    '[01:23:45 REQ aaaaaaaaaaaaaaaa] upstream=api.anthropic.com',
  ]);
});

test('logReq: omits model when absent; ignores unknown fields', () => {
  stubNow('01:23:45');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logReq('id', {
      upstream: 'minimax',
      model: undefined,
      // These are no longer part of the public surface but we should be
      // tolerant of callers that still pass them — they get dropped.
      method: 'POST',
      url: '/x',
      user: 'alice',
    });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  assert.deepEqual(captured, [
    '[01:23:45 REQ id] upstream=minimax',
  ]);
});

// --- logRes ----------------------------------------------------------------

test('logRes: emits upstream/status/duration, then the token bracket, then total', () => {
  stubNow('01:23:46');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logRes('4f7a9b2c', {
      upstream: 'minimax',
      status: 200,
      durationMs: 1234,
      usage: { input_tokens: 1234, output_tokens: 42, cache_read_input_tokens: 5678, cache_creation_input_tokens: 120, total_tokens: 7000 },
    });
  } finally {
    console.log = orig;
    log.__setNowForTest(origNow);
  }

  const RESET = '\x1b[0m';
  const esc = log.__colorEscapeForDuration(1234, 200);   // yellow
  const inEsc = '\x1b[36m';
  const outEsc = '\x1b[35m';
  const crEsc = '\x1b[34m';
  const cwEsc = '\x1b[33m';
  const totalEsc = '\x1b[1;37m';
  assert.deepEqual(captured, [
    `[01:23:46 RES 4f7a9b2c] upstream=minimax status=200 duration=${esc}1.2s${RESET}` +
    ` [in: ${inEsc}1.2k${RESET} | out: ${outEsc}42${RESET} | cache read: ${crEsc}5.7k${RESET} | write: ${cwEsc}120${RESET}] total: ${totalEsc}7k${RESET}`,
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

  const RESET = '\x1b[0m';
  const esc = log.__colorEscapeForDuration(5, 200);     // green
  assert.deepEqual(captured, [
    `[01:23:46 RES id] upstream=minimax status=200 duration=${esc}5ms${RESET}`,
  ]);
});

test('logRes: status >= 400 colors status red and forces duration red', () => {
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

  const RESET = '\x1b[0m';
  // status 502 → red; duration 1234 ms with status 502 → also red (override)
  assert.deepEqual(captured, [
    `[01:23:46 RES id] upstream=minimax status=\x1b[31m502${RESET} duration=\x1b[31m1.2s${RESET}`,
  ]);
});

test('logRes: omits absent token fields inside the bracket', () => {
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

  // No `total:` segment because usage.total_tokens is absent — the spec
  // rule is "total is omitted when total_tokens is absent; it is not
  // computed from the others."
  const RESET = '\x1b[0m';
  const inEsc = '\x1b[36m';
  const outEsc = '\x1b[35m';
  assert.deepEqual(captured, [
    `[01:23:46 RES id] upstream=minimax status=200 duration=\x1b[32m50ms${RESET}` +
    ` [in: ${inEsc}100${RESET} | out: ${outEsc}5${RESET}]`,
  ]);
});

// Cache write with BOTH 5m and 1h TTLs populated: the write segment gets
// a parenthetical split. This is the Anthropic shape that comes through
// normalizeUsage — Haiku (5m only) and Opus/Sonnet (1h only) keep the
// compact form.
test('logRes: cache_creation with both 5m and 1h nonzero shows the TTL split in the write segment', () => {
  stubNow('01:23:46');
  const captured = captureLog(() => logRes('id', {
    upstream: 'anthropic',
    status: 200,
    durationMs: 200,
    usage: {
      input_tokens: 10,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1250,
      cache_creation: { ephemeral_5m_input_tokens: 250, ephemeral_1h_input_tokens: 1000 },
      output_tokens_details: { thinking_tokens: 0 },
      total_tokens: 1310,
    },
  }));
  log.__setNowForTest(origNow);

  const RESET = '\x1b[0m';
  const inEsc = '\x1b[36m';
  const outEsc = '\x1b[35m';
  const crEsc = '\x1b[34m';
  const cwEsc = '\x1b[33m';
  const totalEsc = '\x1b[1;37m';
  // 1250 → 1.3k via Math.round(12.5)/10; 250 → 250 (raw); 1000 → 1k.
  assert.deepEqual(captured, [
    `[01:23:46 RES id] upstream=anthropic status=200 duration=\x1b[32m200ms${RESET}` +
    ` [in: ${inEsc}10${RESET} | out: ${outEsc}50${RESET} | cache read: ${crEsc}0${RESET} | write: ${cwEsc}1.3k${RESET}` +
    ` (5m: ${cwEsc}250${RESET} | 1h: ${cwEsc}1k${RESET})] total: ${totalEsc}1.3k${RESET}`,
  ]);
});

// Cache write with only ONE TTL populated: bracket stays compact (no
// parenthetical), so the Haiku case (5m only) and Sonnet 1h-only case
// don't grow an ugly "5m: 0 | 1h: 17.8k" segment.
test('logRes: cache_creation with a single TTL stays compact (no parenthetical)', () => {
  stubNow('01:23:46');
  const captured = captureLog(() => logRes('id', {
    upstream: 'anthropic',
    status: 200,
    durationMs: 200,
    usage: {
      input_tokens: 3,
      output_tokens: 372,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 17866,
      cache_creation: { ephemeral_5m_input_tokens: 17866, ephemeral_1h_input_tokens: 0 },
      output_tokens_details: { thinking_tokens: 0 },
    },
  }));
  log.__setNowForTest(origNow);

  const RESET = '\x1b[0m';
  const inEsc = '\x1b[36m';
  const outEsc = '\x1b[35m';
  const crEsc = '\x1b[34m';
  const cwEsc = '\x1b[33m';
  // 17866 → 17.9k via __abbrev (one-decimal k-range rounding).
  // No total: segment because total_tokens is null (not reported by Haiku).
  // No (5m: ... | 1h: ...) parenthetical because 1h is 0.
  assert.deepEqual(captured, [
    `[01:23:46 RES id] upstream=anthropic status=200 duration=\x1b[32m200ms${RESET}` +
    ` [in: ${inEsc}3${RESET} | out: ${outEsc}372${RESET} | cache read: ${crEsc}0${RESET} | write: ${cwEsc}17.9k${RESET}]`,
  ]);
});

// Thinking tokens nonzero → extra `think: N` segment after `out:`, before
// the cache fields. This is the segment that makes Opus's hidden thinking
// cost visible in the live log. The color is the bold-white `total` color
// (reusing the existing palette — no new color needed for a one-off
// segment).
test('logRes: output_tokens_details.thinking_tokens > 0 shows a think segment', () => {
  stubNow('01:23:46');
  const captured = captureLog(() => logRes('id', {
    upstream: 'anthropic',
    status: 200,
    durationMs: 800,
    usage: {
      input_tokens: 2,
      output_tokens: 1041,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 267014,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 267014 },
      output_tokens_details: { thinking_tokens: 83 },
      total_tokens: 268057,
    },
  }));
  log.__setNowForTest(origNow);

  const RESET = '\x1b[0m';
  const inEsc = '\x1b[36m';
  const outEsc = '\x1b[35m';
  const crEsc = '\x1b[34m';
  const cwEsc = '\x1b[33m';
  const totalEsc = '\x1b[1;37m';
  // think: 83 between out: and cache read:, in the bold-white color.
  // 1041 → 1k, 267014 → 267k, 268057 → 268.1k (rounding).
  // 5m=0 and 1h=267014: the parenthetical is suppressed because c5 is 0
  // (the "both nonzero" rule), so the bracket stays compact.
  assert.deepEqual(captured, [
    `[01:23:46 RES id] upstream=anthropic status=200 duration=\x1b[32m800ms${RESET}` +
    ` [in: ${inEsc}2${RESET} | out: ${outEsc}1k${RESET} | think: ${totalEsc}83${RESET}` +
    ` | cache read: ${crEsc}0${RESET} | write: ${cwEsc}267k${RESET}] total: ${totalEsc}268.1k${RESET}`,
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
  assert.ok(line.includes('upstream=minimax'), `expected fields after bracket: ${JSON.stringify(line)}`);
  assert.ok(!line.includes('session='), `session must not appear as a field: ${JSON.stringify(line)}`);
});

test('logRes: bracket color matches logReq for the same session_id', () => {
  const origNow = log.__setNowForTest(() => '01:23:45');
  const capturedReq = [];
  const capturedRes = [];
  const orig = console.log;
  try {
    console.log = (line) => capturedReq.push(line);
    logReq('aabbccdd', { upstream: 'minimax', session: 'abc12345' });
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
    logReq('aabbccdd', { upstream: 'minimax' });
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

// --- formatDuration --------------------------------------------------------
// Renders a millisecond duration as a human-friendly string:
//   < 1000 ms   → "#ms"   (e.g. "5ms", "999ms")
//   < 60_000 ms → "#.#s"  (e.g. "1.2s", "30s" — drop trailing .0)
//   ≥ 60_000 ms → "#m #s" (e.g. "1m 5s", "2m 30s")

test('formatDuration: sub-second values render as #ms', () => {
  assert.equal(log.__formatDuration(0), '0ms');
  assert.equal(log.__formatDuration(1), '1ms');
  assert.equal(log.__formatDuration(50), '50ms');
  assert.equal(log.__formatDuration(842), '842ms');
  assert.equal(log.__formatDuration(999), '999ms');
});

test('formatDuration: 1-60s renders as #.#s with trailing .0 dropped', () => {
  assert.equal(log.__formatDuration(1000), '1s');
  assert.equal(log.__formatDuration(1234), '1.2s');
  assert.equal(log.__formatDuration(3000), '3s');
  assert.equal(log.__formatDuration(30000), '30s');
  assert.equal(log.__formatDuration(59500), '59.5s');
  // 59999 ms rounds to 60.0s; bump to minute form so we never emit "60s".
  assert.equal(log.__formatDuration(59999), '1m 0s');
});

test('formatDuration: ≥60s renders as #m #s (no zero-padding on seconds)', () => {
  assert.equal(log.__formatDuration(60000), '1m 0s');
  assert.equal(log.__formatDuration(65000), '1m 5s');
  assert.equal(log.__formatDuration(90000), '1m 30s');
  assert.equal(log.__formatDuration(120000), '2m 0s');
  assert.equal(log.__formatDuration(125000), '2m 5s');
});

test('formatDuration: negative values pass through unchanged', () => {
  assert.equal(log.__formatDuration(-5), '-5');
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

// --- colorEscapeForStatus / colorEscapeForDuration ------------------------

test('colorEscapeForStatus: returns "" for status < 400', () => {
  assert.equal(log.__colorEscapeForStatus(200), '');
  assert.equal(log.__colorEscapeForStatus(201), '');
  assert.equal(log.__colorEscapeForStatus(301), '');
  assert.equal(log.__colorEscapeForStatus(399), '');
});

test('colorEscapeForStatus: returns red escape for status >= 400', () => {
  assert.equal(log.__colorEscapeForStatus(400), '\x1b[31m');
  assert.equal(log.__colorEscapeForStatus(404), '\x1b[31m');
  assert.equal(log.__colorEscapeForStatus(500), '\x1b[31m');
  assert.equal(log.__colorEscapeForStatus(502), '\x1b[31m');
});

test('colorEscapeForDuration: green < 1000, yellow 1000-4999, red >= 5000', () => {
  assert.equal(log.__colorEscapeForDuration(500, 200), '\x1b[32m');
  assert.equal(log.__colorEscapeForDuration(999, 200), '\x1b[32m');
  assert.equal(log.__colorEscapeForDuration(1000, 200), '\x1b[33m');
  assert.equal(log.__colorEscapeForDuration(3000, 200), '\x1b[33m');
  assert.equal(log.__colorEscapeForDuration(4999, 200), '\x1b[33m');
  assert.equal(log.__colorEscapeForDuration(5000, 200), '\x1b[31m');
  assert.equal(log.__colorEscapeForDuration(6000, 200), '\x1b[31m');
});

test('colorEscapeForDuration: red override for status >= 400', () => {
  assert.equal(log.__colorEscapeForDuration(50, 502), '\x1b[31m');
  assert.equal(log.__colorEscapeForDuration(500, 400), '\x1b[31m');
});

// --- colorEscapeForModel ---------------------------------------------------

test('colorEscapeForModel: returns the same escape for the same model string', () => {
  assert.equal(log.__colorEscapeForModel('minimax'), log.__colorEscapeForModel('minimax'));
  assert.equal(log.__colorEscapeForModel('MiniMax-M3'), log.__colorEscapeForModel('MiniMax-M3'));
});

test('colorEscapeForModel: returns a valid SGR escape for any model string', () => {
  const a = log.__colorEscapeForModel('claude-opus-4-8');
  const b = log.__colorEscapeForModel('claude-haiku-4-5-20251001');
  assert.ok(a.startsWith('\x1b['), `expected SGR prefix in: ${JSON.stringify(a)}`);
  assert.ok(b.startsWith('\x1b['), `expected SGR prefix in: ${JSON.stringify(b)}`);
  assert.ok(a.endsWith('m'), `expected SGR suffix in: ${JSON.stringify(a)}`);
  assert.ok(b.endsWith('m'), `expected SGR suffix in: ${JSON.stringify(b)}`);
});
