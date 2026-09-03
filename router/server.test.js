import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyAuth, applyToolCompat, applyThinkingCompat, forward, handleRequest,
  installShutdown, KNOWN_AUTH_MODES, __setRouterShuttingDownForTest,
  assertSupportedProtocol, warnIfInsecureUpstream,
} from './server.js';
import { createFakeUpstream, makeObservableReqRes, SAMPLE_SSE } from '../test-helpers/fake-upstream.mjs';

// server.js's bottom-of-file `listen()` is gated on an entry-point check,
// so importing it here does NOT start a real listening server — node --test
// can exit as soon as the assertions finish. We still set MINIMAX_API_KEY
// as a placeholder so `upstreamConn('minimax')` inside handleRequest doesn't
// throw on the mapped-route test. We trust the self-signed upstream cert
// only inside this process.
process.env.MINIMAX_API_KEY ||= 'test-key-not-used';
process.env.NODE_TLS_REJECT_UNAUTHORIZED ||= '0';

// Hermetic STATS_EVENTS_FILE: every test gets its own tmpdir so the new
// logEvent call inside finalize() doesn't write to /tmp. Cleared in afterEach
// so a stray file from a test can't leak into the next.
let statsDir;
beforeEach(() => {
  statsDir = mkdtempSync(join(tmpdir(), 'router-stats-'));
  process.env.STATS_EVENTS_FILE = join(statsDir, 'events.jsonl');
});
afterEach(() => {
  delete process.env.STATS_EVENTS_FILE;
  rmSync(statsDir, { recursive: true, force: true });
  // Belt-and-braces reset for the routerShuttingDown test seam: individual
  // tests that flip it already reset it in their own `finally`, but this
  // catches any test that throws before reaching that reset, so a later
  // test never silently inherits "shutting down" state from an earlier one.
  __setRouterShuttingDownForTest(false);
});

// --- applyAuth -------------------------------------------------------------

test('applyAuth: passthrough leaves incoming x-api-key and authorization intact', () => {
  const headers = { 'x-api-key': 'sk-ant-subscription-token', authorization: 'Bearer something' };
  applyAuth(headers, { auth: 'passthrough', key: null });
  assert.equal(headers['x-api-key'], 'sk-ant-subscription-token');
  assert.equal(headers.authorization, 'Bearer something');
});

test('applyAuth: bearer strips incoming auth and sets Authorization: Bearer <key>', () => {
  const headers = { 'x-api-key': 'sk-ant-leaked', authorization: 'Bearer leaked' };
  applyAuth(headers, { auth: 'bearer', key: 'minimax-key-123' });
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers.authorization, 'Bearer minimax-key-123');
});

test('applyAuth: x-api-key strips incoming auth and sets x-api-key: <key>', () => {
  const headers = { 'x-api-key': 'sk-ant-leaked', authorization: 'Bearer leaked' };
  applyAuth(headers, { auth: 'x-api-key', key: 'ant-key-456' });
  assert.equal(headers['x-api-key'], 'ant-key-456');
  assert.equal(headers.authorization, undefined);
});

test('KNOWN_AUTH_MODES: lists the three recognized modes', () => {
  assert.deepEqual([...KNOWN_AUTH_MODES].sort(), ['bearer', 'passthrough', 'x-api-key']);
});

// --- assertSupportedProtocol ------------------------------------------------
// upstreamConn() calls this on every resolved base URL so a config typo
// (e.g. ftp:// or a bare hostname parsed with an unexpected scheme) fails
// fast with the same clean configuration-error path as an unknown upstream,
// instead of reaching forward() and blowing up on request construction.

test('assertSupportedProtocol: http: and https: are accepted', () => {
  assert.doesNotThrow(() => assertSupportedProtocol(new URL('http://example.com'), 'x'));
  assert.doesNotThrow(() => assertSupportedProtocol(new URL('https://example.com'), 'x'));
});

test('assertSupportedProtocol: unsupported scheme throws a clean config error', () => {
  assert.throws(
    () => assertSupportedProtocol(new URL('ftp://example.com'), 'weird-upstream'),
    /Unsupported protocol 'ftp:' for upstream 'weird-upstream'/
  );
});

// --- warnIfInsecureUpstream -------------------------------------------------
// A keyed upstream (bearer/x-api-key) reachable only over http: to a
// non-loopback host would send its API key in cleartext. warnIfInsecureUpstream
// logs a one-time warning (no secret) for that case; every other combination
// (https:, loopback host, or passthrough auth) is silent.

function captureConsoleError() {
  const captured = [];
  const orig = console.error;
  console.error = (line) => captured.push(line);
  return { lines: captured, restore: () => { console.error = orig; } };
}

test('warnIfInsecureUpstream: warns once for a keyed http: upstream on a non-loopback host', () => {
  const cap = captureConsoleError();
  try {
    warnIfInsecureUpstream(new URL('http://upstream.example.com'), 'flaky-http-upstream', 'bearer');
    warnIfInsecureUpstream(new URL('http://upstream.example.com'), 'flaky-http-upstream', 'bearer');
  } finally {
    cap.restore();
  }
  const warnings = cap.lines.filter((l) => /WARNING.*flaky-http-upstream/.test(l));
  assert.equal(warnings.length, 1, `expected exactly one warning across two calls, got: ${JSON.stringify(cap.lines)}`);
  assert.match(warnings[0], /http:.*non-loopback|cleartext/i);
});

test('warnIfInsecureUpstream: passthrough auth is silent even over http: to a non-loopback host', () => {
  const cap = captureConsoleError();
  try {
    warnIfInsecureUpstream(new URL('http://upstream.example.com'), 'passthrough-http-upstream', 'passthrough');
  } finally {
    cap.restore();
  }
  assert.deepEqual(cap.lines, []);
});

test('warnIfInsecureUpstream: https: is silent for keyed auth', () => {
  const cap = captureConsoleError();
  try {
    warnIfInsecureUpstream(new URL('https://upstream.example.com'), 'https-upstream', 'bearer');
  } finally {
    cap.restore();
  }
  assert.deepEqual(cap.lines, []);
});

test('warnIfInsecureUpstream: loopback host is silent for keyed http: auth', () => {
  const cap = captureConsoleError();
  try {
    warnIfInsecureUpstream(new URL('http://127.0.0.1:9999'), 'loopback-http-upstream', 'x-api-key');
    warnIfInsecureUpstream(new URL('http://localhost:9999'), 'loopback-http-upstream-2', 'x-api-key');
  } finally {
    cap.restore();
  }
  assert.deepEqual(cap.lines, []);
});

// --- applyToolCompat -------------------------------------------------------
// MiniMax's Anthropic-compatible endpoint rejects any tool entry that
// lacks an `input_schema` with "function name or parameters is empty".
// Anthropic built-in server tools (web_fetch, web_search, bash, etc.) are
// advertised with a `type` discriminator and no `input_schema`; the shim
// injects a permissive schema so the entry is accepted. Entries that
// already carry an `input_schema` are left alone. Keyed on upstream name
// so Anthropic/passthrough traffic is untouched.

test('applyToolCompat: minimax injects input_schema on entries that lack one', () => {
  const body = {
    model: 'minimax',
    tools: [
      { type: 'web_fetch_20250924', name: 'web_fetch' },
      { type: 'web_search_20250305', name: 'web_search' },
      { name: 'Read', description: 'Read a file', input_schema: { type: 'object' } },
    ],
  };
  applyToolCompat(body, 'minimax');
  assert.deepEqual(body.tools[0].input_schema, { type: 'object', additionalProperties: true });
  assert.equal(body.tools[0].name, 'web_fetch');
  assert.equal(body.tools[0].type, 'web_fetch_20250924');
  assert.deepEqual(body.tools[1].input_schema, { type: 'object', additionalProperties: true });
  // Pre-existing input_schema is preserved, not overwritten.
  assert.deepEqual(body.tools[2].input_schema, { type: 'object' });
});

test('applyToolCompat: anthropic upstream is a no-op', () => {
  const body = {
    model: 'claude-opus-4-7',
    tools: [{ type: 'web_fetch_20250924', name: 'web_fetch' }],
  };
  applyToolCompat(body, 'anthropic');
  assert.equal(body.tools[0].input_schema, undefined);
});

test('applyToolCompat: body with no tools array is a no-op', () => {
  const body = { model: 'minimax', messages: [] };
  applyToolCompat(body, 'minimax');
  assert.deepEqual(body, { model: 'minimax', messages: [] });
});

test('applyToolCompat: tool entries that already have input_schema are left alone', () => {
  const body = {
    model: 'minimax',
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  };
  const before = JSON.stringify(body);
  applyToolCompat(body, 'minimax');
  assert.equal(JSON.stringify(body), before);
});

// --- applyThinkingCompat -----------------------------------------------------
// MiniMax-M3 defaults thinking to `disabled` unless the request sets
// `thinking: { type: "adaptive" }`; M2.x models can't turn it off at all.
// The shim forces `adaptive` on every MiniMax request so reasoning is always
// on, overriding whatever the client sent. Keyed on upstream name, like
// applyToolCompat, so Anthropic/passthrough traffic is untouched.

test('applyThinkingCompat: minimax gets thinking forced to adaptive', () => {
  const body = { model: 'minimax', messages: [] };
  applyThinkingCompat(body, 'minimax');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
});

test('applyThinkingCompat: overrides an explicit disabled from the client', () => {
  const body = { model: 'minimax', thinking: { type: 'disabled' }, messages: [] };
  applyThinkingCompat(body, 'minimax');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
});

test('applyThinkingCompat: anthropic upstream is a no-op', () => {
  const body = { model: 'claude-opus-4-7', messages: [] };
  applyThinkingCompat(body, 'anthropic');
  assert.equal(body.thinking, undefined);
});

// --- body-guard ------------------------------------------------------------
// The router's body type-guard converts a `body.model` TypeError on JSON
// `null`/array/non-object bodies into a clean 400. We test the same predicate
// here against the same input shapes the router checks for.

function isRouteableObject(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

test('body-guard: null is not routeable', () => {
  assert.equal(isRouteableObject(null), false);
});

test('body-guard: arrays are not routeable', () => {
  assert.equal(isRouteableObject([]), false);
  assert.equal(isRouteableObject([1, 2, 3]), false);
});

test('body-guard: strings/numbers are not routeable', () => {
  assert.equal(isRouteableObject('hello'), false);
  assert.equal(isRouteableObject(42), false);
});

test('body-guard: plain objects ARE routeable', () => {
  assert.equal(isRouteableObject({}), true);
  assert.equal(isRouteableObject({ model: 'x' }), true);
});

// --- forward() dispatch ----------------------------------------------------
// Regression for ERR_INVALID_PROTOCOL: the router used to call http.request()
// with a `protocol: 'https:'` option, which http.request rejects outright
// (it only accepts 'http:'). The fix routes every upstream through
// https.request(), which honors the `protocol` option. We point at
// https://127.0.0.1:1 — a closed port, so the fix path surfaces a real
// ECONNREFUSED that the error handler converts to 502. The bug path would
// have thrown synchronously at ClientRequest construction, before the error
// handler could run, so the client would see no writeHead at all.

test('forward: https:// upstream reaches the error handler (regression: ERR_INVALID_PROTOCOL)', async () => {
  const conn = { url: new URL('https://127.0.0.1:1'), key: null, auth: 'passthrough' };
  const { req, res, getStatus, getBody } = makeObservableReqRes();

  // Capture logRes output so we can assert the RES line was emitted for
  // the 502 path. Suppress console.log for the test's duration.
  const captured = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (line) => captured.push(line);
  console.error = () => {};

  try {
    forward(req, res, conn, Buffer.from('{"model":"x"}'), { id: 'test-id-1', t0: Date.now() - 5 });
    await new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
      setTimeout(() => reject(new Error('forward timed out after 5s')), 5000);
    });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  assert.equal(getStatus(), 502, 'error handler should set 502 on unreachable upstream');
  assert.equal(getBody(), 'upstream error');
  // The error path must still emit a RES line so failed requests show up
  // in observability logs. The status value is color-wrapped in red since
  // status >= 400, so we strip ANSI before matching the literal value.
  const resLine = captured.find((l) => /^\[\d{2}:\d{2}:\d{2} RES test-id-1\]/.test(l));
  assert.ok(resLine, `expected a RES line for the failed request, got: ${JSON.stringify(captured)}`);
  const stripped = resLine.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(stripped, /status=502/);
  assert.match(stripped, /upstream=127\.0\.0\.1/);
});

// forward() must pick http.request for a plain-http:// upstream (https.request
// rejects a 'http:' protocol option outright, and always using https.request
// — the pre-fix behavior — throws synchronously for genuine http:// upstreams
// before the error handler can run). Stand up a real ephemeral plain-HTTP
// server so the request actually completes end-to-end.

test('forward: http:// upstream — request reaches a real plain-HTTP server, status/body flow through, RES line emitted', async () => {
  const plainServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => plainServer.listen(0, '127.0.0.1', resolve));
  const port = plainServer.address().port;

  try {
    const conn = { url: new URL(`http://127.0.0.1:${port}`), key: null, auth: 'passthrough' };
    const { req, res, getStatus, getBody } = makeObservableReqRes();

    const captured = [];
    const origLog = console.log;
    console.log = (line) => captured.push(line);
    try {
      forward(req, res, conn, Buffer.from('{"model":"x"}'), { id: 'http-test', t0: Date.now() - 5 });
      await new Promise((resolve, reject) => {
        res.on('finish', resolve);
        res.on('error', reject);
        setTimeout(() => reject(new Error('forward timed out after 5s')), 5000);
      });
    } finally {
      console.log = origLog;
    }

    assert.equal(getStatus(), 200);
    assert.equal(getBody(), JSON.stringify({ ok: true }));
    const resLine = captured.find((l) => /^\[\d{2}:\d{2}:\d{2} RES http-test\]/.test(l));
    assert.ok(resLine, `expected a RES line, got: ${JSON.stringify(captured)}`);
    const stripped = resLine.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(stripped, /status=200/);
    assert.match(stripped, /upstream=127\.0\.0\.1/);
  } finally {
    await new Promise((resolve) => plainServer.close(resolve));
  }
});

// --- handleRequest — REQ line ----------------------------------------------
// These tests capture console.log to assert the REQ line emitted for each
// routing path. The actual upstream is never contacted: handleRequest emits
// the REQ line before calling forward(), so the closed-port error from
// forward() (if any) doesn't affect the assertion. The tests don't assert
// on the RES line.

function captureLog() {
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  return {
    lines: captured,
    restore: () => { console.log = orig; },
  };
}

function makePostReq(bodyObj, url = '/v1/messages') {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = url;
  req.headers = { host: 'router' };
  const body = JSON.stringify(bodyObj);
  // Push the body in a microtask so listeners attached after construction
  // (the data/end handlers inside handleRequest) still fire.
  queueMicrotask(() => {
    req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function makeGetReq(url) {
  const req = new EventEmitter();
  req.method = 'GET';
  req.url = url;
  req.headers = { host: 'router' };
  queueMicrotask(() => req.emit('end'));
  return req;
}

test('handleRequest: REQ line for mapped route includes the rewritten real model', async () => {
  const cap = captureLog();
  try {
    const req = makePostReq({ model: 'minimax', messages: [], metadata: { user_id: 'u1' } });
    const res = new Writable({ write(_c, _e, cb) { cb(); } });
    res.writeHead = () => res;
    res.headersSent = false;
    handleRequest(req, res);
    // Wait for the request body to flush and the REQ line to log.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    cap.restore();
  }

  const reqLine = cap.lines.find((l) => /^\[\d{2}:\d{2}:\d{2} REQ /.test(l));
  assert.ok(reqLine, `expected a REQ line, got: ${JSON.stringify(cap.lines)}`);
  // Strip ANSI from the value part of `key=value` so the regex matches the
  // color-wrapped model value (e.g. model=\x1B[36mMiniMax-M3\x1B[0m).
  const stripped = reqLine.replace(/\x1b\[[0-9;]*m/g, '');
  // Trimmed shape: only model and upstream, plus the bracket.
  assert.match(stripped, /model=MiniMax-M3/);
  assert.match(stripped, /upstream=api\.minimax\.io/);
  // The dropped fields must not appear.
  assert.doesNotMatch(stripped, /method=/);
  assert.doesNotMatch(stripped, /url=/);
  assert.doesNotMatch(stripped, /route=/);
  assert.doesNotMatch(stripped, /user=/);
});

test('handleRequest: REQ line for unmapped model shows model and default upstream, no route or user', async () => {
  const cap = captureLog();
  try {
    const req = makePostReq({ model: 'claude-sonnet-4-6', messages: [] });
    const res = new Writable({ write(_c, _e, cb) { cb(); } });
    res.writeHead = () => res;
    res.headersSent = false;
    handleRequest(req, res);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    cap.restore();
  }

  const reqLine = cap.lines.find((l) => /^\[\d{2}:\d{2}:\d{2} REQ /.test(l));
  assert.ok(reqLine, `expected a REQ line, got: ${JSON.stringify(cap.lines)}`);
  // Strip ANSI so the regex matches the color-wrapped model value.
  const stripped = reqLine.replace(/\x1b\[[0-9;]*m/g, '');
  // For passthrough, model is whatever the body said.
  assert.match(stripped, /model=claude-sonnet-4-6/);
  assert.doesNotMatch(stripped, /route=/);
  assert.doesNotMatch(stripped, /user=/);
  assert.doesNotMatch(stripped, /method=/);
  assert.doesNotMatch(stripped, /url=/);
  assert.match(stripped, /upstream=api\.anthropic\.com/);
});

test('handleRequest: REQ line for a bodyless GET omits model', async () => {
  const cap = captureLog();
  try {
    const req = makeGetReq('/v1/models');
    const res = new Writable({ write(_c, _e, cb) { cb(); } });
    res.writeHead = () => res;
    res.headersSent = false;
    handleRequest(req, res);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    cap.restore();
  }

  const reqLine = cap.lines.find((l) => /^\[\d{2}:\d{2}:\d{2} REQ /.test(l));
  assert.ok(reqLine, `expected a REQ line, got: ${JSON.stringify(cap.lines)}`);
  assert.doesNotMatch(reqLine, /model=/);
  assert.doesNotMatch(reqLine, /route=/);
  assert.doesNotMatch(reqLine, /user=/);
  assert.doesNotMatch(reqLine, /method=/);
  assert.doesNotMatch(reqLine, /url=/);
  assert.match(reqLine, /upstream=api\.anthropic\.com/);
});

// --- forward() — SSE usage extraction + disconnect handling -----------------
// The new forward() buffers the upstream response and scans it for the final
// `usage` block, then writes a RES line with that usage. To exercise the
// end-to-end path we stand up a small HTTPS server with a self-signed cert
// and point the router at it. The cert is generated once per test run in
// before(); the cert directory is removed in after().

// One long-lived HTTPS upstream shared across the SSE-suite tests; each
// test installs a fresh request handler via `upstream.respond = fn`. The
// cert, the listen(), and the cleanup live in test-helpers/fake-upstream.mjs.
const upstream = createFakeUpstream();
let fakeServerCounter = 0; // unique baseUrl per test so req.url paths line up

before(async () => {
  await upstream.start();
});

after(async () => {
  await upstream.stop();
});

// Per-test observable req/res. The unique url avoids any cross-test
// interference in the path-keyed log lines.
function makeReqResForForward() {
  return makeObservableReqRes({ url: `/v1/messages-${++fakeServerCounter}` });
}

test('forward: SSE stream — extracts usage from message_delta and emits a token bracket on the RES line', async () => {
  const conn = { url: new URL(`https://127.0.0.1:${upstream.port}`), key: null, auth: 'passthrough' };
  upstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SAMPLE_SSE);
  };

  const { req, res, getStatus, getBody } = makeReqResForForward();
  const captured = [];
  const origLog = console.log;
  console.log = (line) => captured.push(line);
  try {
    forward(req, res, conn, Buffer.from('{"model":"x"}'), { id: 'sse-test', t0: Date.now() - 5 });
    await new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
      setTimeout(() => reject(new Error('forward timed out after 5s')), 5000);
    });
  } finally {
    console.log = origLog;
  }

  assert.equal(getStatus(), 200);
  // Bytes flowed through to the client.
  assert.equal(getBody(), SAMPLE_SSE);
  // The RES line must carry the token bracket. The exact format is locked
  // in by lib/log.test.js; we strip ANSI and regex-match the salient
  // pieces so the assertion survives minor log-format refactors.
  const resLine = captured.find((l) => /^\[\d{2}:\d{2}:\d{2} RES sse-test\]/.test(l));
  assert.ok(resLine, `expected a RES line, got: ${JSON.stringify(captured)}`);
  const stripped = resLine.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(stripped, /upstream=127\.0\.0\.1/);
  assert.match(stripped, /status=200/);
  assert.match(stripped, /\[in: 10 \| out: 42 \| cache read: 0 \| write: 1\.2k\]/);
  assert.match(stripped, /total: 52/);
});

test('forward: non-SSE JSON body — falls back to JSON.parse(text).usage', async () => {
  const conn = { url: new URL(`https://127.0.0.1:${upstream.port}`), key: null, auth: 'passthrough' };
  const jsonBody = JSON.stringify({
    id: 'msg_01', type: 'message', role: 'assistant', content: [],
    usage: { input_tokens: 100, output_tokens: 9, total_tokens: 109 },
  });
  upstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(jsonBody);
  };

  const { req, res } = makeReqResForForward();
  const captured = [];
  const origLog = console.log;
  console.log = (line) => captured.push(line);
  try {
    forward(req, res, conn, Buffer.from('{"model":"x"}'), { id: 'json-test', t0: Date.now() - 5 });
    await new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
      setTimeout(() => reject(new Error('forward timed out after 5s')), 5000);
    });
  } finally {
    console.log = origLog;
  }

  const resLine = captured.find((l) => /^\[\d{2}:\d{2}:\d{2} RES json-test\]/.test(l));
  assert.ok(resLine, `expected a RES line, got: ${JSON.stringify(captured)}`);
  const stripped = resLine.replace(/\x1b\[[0-9;]*m/g, '');
  // After normalizeUsage the cache_* and thinking fields are always
  // present (defaulting to 0), so the bracket includes them.
  assert.match(stripped, /\[in: 100 \| out: 9 \| cache read: 0 \| write: 0\]/);
  assert.match(stripped, /total: 109/);
});

test('forward: no usage in response — RES line omits the token bracket, no crash', async () => {
  const conn = { url: new URL(`https://127.0.0.1:${upstream.port}`), key: null, auth: 'passthrough' };
  upstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // ping event with no usage anywhere.
    res.end('event: ping\ndata: {}\n\n');
  };

  const { req, res } = makeReqResForForward();
  const captured = [];
  const origLog = console.log;
  console.log = (line) => captured.push(line);
  try {
    forward(req, res, conn, Buffer.from('{"model":"x"}'), { id: 'nope-test', t0: Date.now() - 5 });
    await new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
      setTimeout(() => reject(new Error('forward timed out after 5s')), 5000);
    });
  } finally {
    console.log = origLog;
  }

  const resLine = captured.find((l) => /^\[\d{2}:\d{2}:\d{2} RES nope-test\]/.test(l));
  assert.ok(resLine, `expected a RES line, got: ${JSON.stringify(captured)}`);
  const stripped = resLine.replace(/\x1b\[[0-9;]*m/g, '');
  // No bracket, no total.
  assert.doesNotMatch(stripped, /\[in:/);
  assert.doesNotMatch(stripped, /total:/);
  assert.match(stripped, /upstream=127\.0\.0\.1(:\d+)? status=200/);
});

test('forward: client disconnects mid-stream — synthetic 499 RES line fires and upstream is destroyed', async () => {
  const conn = { url: new URL(`https://127.0.0.1:${upstream.port}`), key: null, auth: 'passthrough' };
  // The handler writes the message_start event, then a slow trickle, then
  // never ends on its own — only the destroy() in the test will close the
  // response. We capture only the upstream *request* close (which fires
  // when the router calls upstreamReq.destroy()); the server-side response
  // close isn't observed because nothing in this test asserts on it.
  let reqDestroyed = false;
  upstream.respond = (req, res) => {
    req.on('close', () => { reqDestroyed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n');
    // No res.end() — the test will destroy the client to trigger the
    // router's res.on('close') path, which should call upstreamReq.destroy().
  };

  const { req, res } = makeReqResForForward();
  const captured = [];
  const origLog = console.log;
  console.log = (line) => captured.push(line);
  try {
    forward(req, res, conn, Buffer.from('{"model":"x"}'), { id: 'abort-test', t0: Date.now() - 5 });
    // Give the request a moment to connect and reach the handler.
    await new Promise((r) => setTimeout(r, 100));
    // Client goes away.
    res.destroy();
    // Wait for the router's res.on('close') to log the synthetic 499.
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    console.log = origLog;
  }

  // Synthetic RES line for the disconnect.
  const resLine = captured.find((l) => /^\[\d{2}:\d{2}:\d{2} RES abort-test\]/.test(l));
  assert.ok(resLine, `expected a RES line, got: ${JSON.stringify(captured)}`);
  const stripped = resLine.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(stripped, /status=499/);
  // Upstream request must be destroyed so we stop paying for the response.
  assert.equal(reqDestroyed, true, 'upstream request should be destroyed on client disconnect');
  // Sanity: the test fixture fired the message_start event, so without
  // the disconnect we WOULD have seen a token bracket; the disconnect path
  // intentionally logs no usage.
  assert.doesNotMatch(stripped, /\[in:/);
});

test('forward: empty-body HTTP 200 — converts to 502 with error JSON and logs console.error', async () => {
  const conn = { url: new URL(`https://127.0.0.1:${upstream.port}`), key: null, auth: 'passthrough' };
  upstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end();
  };

  const { req, res, getStatus, getBody } = makeReqResForForward();
  const logCaptured = [];
  const errCaptured = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (line) => logCaptured.push(line);
  console.error = (line) => errCaptured.push(line);
  try {
    forward(req, res, conn, Buffer.from('{"model":"x"}'), { id: 'empty-test', t0: Date.now() - 5 });
    await new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
      setTimeout(() => reject(new Error('forward timed out after 5s')), 5000);
    });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  assert.equal(getStatus(), 502, 'empty 200 should be converted to 502');
  assert.ok(getBody().includes('empty response'), `expected error body, got: ${getBody()}`);
  assert.ok(
    errCaptured.some((l) => /UPSTREAM EMPTY RESPONSE/.test(l)),
    `expected console.error with UPSTREAM EMPTY RESPONSE, got: ${JSON.stringify(errCaptured)}`
  );
  const resLine = logCaptured.find((l) => /^\[\d{2}:\d{2}:\d{2} RES empty-test\]/.test(l));
  assert.ok(resLine, `expected a RES line, got: ${JSON.stringify(logCaptured)}`);
  const stripped = resLine.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(stripped, /status=502/);
});

test('forward: empty-body HTTP 200 during a shutdown drain — still 502s the client, but does not log UPSTREAM EMPTY RESPONSE', async () => {
  const conn = { url: new URL(`https://127.0.0.1:${upstream.port}`), key: null, auth: 'passthrough' };
  upstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end();
  };

  const { req, res, getStatus, getBody } = makeReqResForForward();
  const errCaptured = [];
  const origErr = console.error;
  console.error = (line) => errCaptured.push(line);
  __setRouterShuttingDownForTest(true);
  try {
    forward(req, res, conn, Buffer.from('{"model":"x"}'), { id: 'empty-during-shutdown', t0: Date.now() - 5 });
    await new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
      setTimeout(() => reject(new Error('forward timed out after 5s')), 5000);
    });
  } finally {
    console.error = origErr;
    __setRouterShuttingDownForTest(false);
  }

  // The client still needs an error response — only the misleading log is suppressed.
  assert.equal(getStatus(), 502, 'empty 200 should still be converted to 502');
  assert.ok(getBody().includes('empty response'), `expected error body, got: ${getBody()}`);
  assert.ok(
    !errCaptured.some((l) => /UPSTREAM EMPTY RESPONSE/.test(l)),
    `expected no UPSTREAM EMPTY RESPONSE log during shutdown, got: ${JSON.stringify(errCaptured)}`
  );
});

// --- installShutdown: graceful + force shutdown (SIGTERM/SIGINT) -----------
// The router is meant to drain in-flight streaming responses on the first
// SIGTERM or SIGINT instead of killing them, and force-destroy remaining
// sockets on any subsequent signal (including a mixed pair). We exercise
// the state machine directly with a stub server and stub exit so we don't
// actually kill the test process. installShutdown also wires
// `process.on('SIGTERM'/'SIGINT', ...)` — that's fine in tests because we
// drive the handler through the returned `onSignal` reference rather than
// sending a real signal.

function captureConsoleLog() {
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  return { lines: captured, restore: () => { console.log = orig; } };
}

test('installShutdown: graceful — logs initial open count, drains, then exits', async () => {
  // A bare http server is enough — installShutdown only listens for
  // 'connection' on whatever we hand it, not on any specific request
  // handler.
  const srv = http.createServer();
  const exitCalls = [];
  const handle = installShutdown(srv, { exit: (code) => exitCalls.push(code) });
  const cap = captureConsoleLog();
  try {
    // Stand up a real listening server so the kernel can give us a port,
    // then open a client socket and hand it to the tracker manually.
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    const client = net.createConnection(port, '127.0.0.1');
    await new Promise((resolve) => client.on('connect', resolve));
    // 'connect' on the client fires when the kernel completes the TCP
    // handshake, but the server's 'connection' event runs in a separate
    // tick — wait for the tracker to see the socket.
    const serverSide = await new Promise((resolve, reject) => {
      const tick = () => {
        const s = [...handle.openConnections][0];
        if (s) resolve(s);
        else setImmediate(tick);
      };
      tick();
      setTimeout(() => reject(new Error('socket never appeared in tracker')), 1000);
    });
    assert.ok(serverSide, 'server should have tracked the new socket');

    // First SIGTERM: log the open count and start server.close(). No exit yet.
    handle.onSignal('SIGTERM');
    assert.equal(handle.shuttingDown, true);
    assert.deepEqual(exitCalls, [], 'should not exit while connections are open');
    assert.match(
      cap.lines.find((l) => l.startsWith('[shutdown] received SIGTERM')) ?? '',
      /\(1 open connection\(s\)\)/
    );

    // Close the client; the server-side socket should emit 'close', the
    // tracker should remove it, the drain log should fire, and exit
    // should be called with code 0.
    client.destroy();
    await new Promise((resolve) => serverSide.on('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 20)); // let listeners settle
    assert.equal(handle.openConnections.size, 0);
    assert.deepEqual(exitCalls, [0]);
    assert.ok(
      cap.lines.some((l) => /\[shutdown\] connection closed \(0 remaining\)/.test(l)),
      `expected drain log, got: ${JSON.stringify(cap.lines)}`
    );
  } finally {
    cap.restore();
    handle.uninstall();
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('installShutdown: zero connections on SIGTERM — exits cleanly', async () => {
  // The server must be listening when SIGTERM fires; that's the only
  // configuration installShutdown is meant to support. We bind to an
  // ephemeral port; by the time the test calls onSignal the set is empty.
  const srv = http.createServer();
  const exitCalls = [];
  const handle = installShutdown(srv, { exit: (code) => exitCalls.push(code) });
  const cap = captureConsoleLog();
  try {
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    handle.onSignal('SIGTERM');
    assert.equal(handle.shuttingDown, true);
    // server.close()'s callback fires on the next tick; exit(0) runs
    // inside it because openConnections is empty.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      cap.lines.some((l) => /\[shutdown\] received SIGTERM, beginning graceful shutdown \(0 open connection\(s\)\)/.test(l)),
      `expected initial shutdown log, got: ${JSON.stringify(cap.lines)}`
    );
    assert.deepEqual(exitCalls, [0]);
  } finally {
    cap.restore();
    handle.uninstall();
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('installShutdown: second SIGTERM during drain — destroys remaining sockets and exits', async () => {
  const srv = http.createServer();
  const exitCalls = [];
  const handle = installShutdown(srv, { exit: (code) => exitCalls.push(code) });
  const cap = captureConsoleLog();
  try {
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    const client = net.createConnection(port, '127.0.0.1');
    await new Promise((resolve) => client.on('connect', resolve));
    // 'connect' on the client fires when the kernel completes the TCP
    // handshake, but the server's 'connection' event runs in a separate
    // tick — wait for the tracker to see the socket so the test is
    // deterministic.
    const serverSide = await new Promise((resolve, reject) => {
      const tick = () => {
        const s = [...handle.openConnections][0];
        if (s) resolve(s);
        else setImmediate(tick);
      };
      tick();
      setTimeout(() => reject(new Error('socket never appeared in tracker')), 1000);
    });
    let destroyed = false;
    const origDestroy = serverSide.destroy.bind(serverSide);
    serverSide.destroy = (...args) => { destroyed = true; return origDestroy(...args); };

    // Begin graceful shutdown — does NOT exit (still 1 connection).
    handle.onSignal('SIGTERM');
    assert.deepEqual(exitCalls, []);

    // Second SIGTERM — force path. Should destroy the remaining socket
    // and call exit(0).
    handle.onSignal('SIGTERM');
    assert.deepEqual(exitCalls, [0]);
    assert.equal(destroyed, true, 'force path should destroy remaining socket');
    assert.ok(
      cap.lines.some((l) => /\[shutdown\] received second signal \(SIGTERM\), forcing immediate shutdown \(1 connection\(s\) still open\)/.test(l)),
      `expected force log, got: ${JSON.stringify(cap.lines)}`
    );

    client.destroy();
  } finally {
    cap.restore();
    handle.uninstall();
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('installShutdown: graceful — first SIGINT logs, drains, then exits', async () => {
  // Mirrors the SIGTERM graceful test above but drives the state machine
  // via SIGINT (e.g. Ctrl-C during local/dev use). Same drain semantics,
  // different signal name in the log line.
  const srv = http.createServer();
  const exitCalls = [];
  const handle = installShutdown(srv, { exit: (code) => exitCalls.push(code) });
  const cap = captureConsoleLog();
  try {
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    const client = net.createConnection(port, '127.0.0.1');
    await new Promise((resolve) => client.on('connect', resolve));
    const serverSide = await new Promise((resolve, reject) => {
      const tick = () => {
        const s = [...handle.openConnections][0];
        if (s) resolve(s);
        else setImmediate(tick);
      };
      tick();
      setTimeout(() => reject(new Error('socket never appeared in tracker')), 1000);
    });
    assert.ok(serverSide, 'server should have tracked the new socket');

    // First SIGINT: log the open count and start server.close(). No exit yet.
    handle.onSignal('SIGINT');
    assert.equal(handle.shuttingDown, true);
    assert.deepEqual(exitCalls, [], 'should not exit while connections are open');
    assert.match(
      cap.lines.find((l) => l.startsWith('[shutdown] received SIGINT')) ?? '',
      /\(1 open connection\(s\)\)/
    );

    // Close the client; the server-side socket should emit 'close', the
    // tracker should remove it, the drain log should fire, and exit
    // should be called with code 0.
    client.destroy();
    await new Promise((resolve) => serverSide.on('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 20)); // let listeners settle
    assert.equal(handle.openConnections.size, 0);
    assert.deepEqual(exitCalls, [0]);
    assert.ok(
      cap.lines.some((l) => /\[shutdown\] connection closed \(0 remaining\)/.test(l)),
      `expected drain log, got: ${JSON.stringify(cap.lines)}`
    );
  } finally {
    cap.restore();
    handle.uninstall();
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('installShutdown: mixed signal (SIGTERM then SIGINT) forces shutdown and logs the actual second signal', async () => {
  // A first SIGTERM begins the graceful drain; an operator (or process
  // supervisor) sending a different signal, SIGINT, before the drain
  // completes must still force-destroy the remaining sockets — and the
  // force log must name the signal that actually arrived (SIGINT), not
  // hard-code SIGTERM.
  const srv = http.createServer();
  const exitCalls = [];
  const handle = installShutdown(srv, { exit: (code) => exitCalls.push(code) });
  const cap = captureConsoleLog();
  try {
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = srv.address().port;
    const client = net.createConnection(port, '127.0.0.1');
    await new Promise((resolve) => client.on('connect', resolve));
    const serverSide = await new Promise((resolve, reject) => {
      const tick = () => {
        const s = [...handle.openConnections][0];
        if (s) resolve(s);
        else setImmediate(tick);
      };
      tick();
      setTimeout(() => reject(new Error('socket never appeared in tracker')), 1000);
    });
    let destroyed = false;
    const origDestroy = serverSide.destroy.bind(serverSide);
    serverSide.destroy = (...args) => { destroyed = true; return origDestroy(...args); };

    // Begin graceful shutdown via SIGTERM — does NOT exit (still 1 connection).
    handle.onSignal('SIGTERM');
    assert.deepEqual(exitCalls, []);

    // A mixed second signal (SIGINT) — force path. Should destroy the
    // remaining socket, exit(0), and log SIGINT (the signal that actually
    // arrived), not SIGTERM.
    handle.onSignal('SIGINT');
    assert.deepEqual(exitCalls, [0]);
    assert.equal(destroyed, true, 'force path should destroy remaining socket');
    assert.ok(
      cap.lines.some((l) => /\[shutdown\] received second signal \(SIGINT\), forcing immediate shutdown \(1 connection\(s\) still open\)/.test(l)),
      `expected force log naming SIGINT, got: ${JSON.stringify(cap.lines)}`
    );

    client.destroy();
  } finally {
    cap.restore();
    handle.uninstall();
    await new Promise((resolve) => srv.close(resolve));
  }
});

// --- finalize() → logEvent wiring ------------------------------------------
// Every successful request must produce a JSONL record in STATS_EVENTS_FILE.
// We don't stand up a real upstream here — the test's goal is to assert the
// event-emission wiring, not the upstream behavior. The mock upstream in
// handleRequest is good enough: the unmapped-model path falls through to
// 127.0.0.1:1, the request fails with 502, and finalize() still fires with
// the model fields populated. (We just need to see *one* event line.)

test('handleRequest: writes a JSONL event line on successful completion', async () => {
  // For this test we DO need a real upstream so the request reaches a
  // normal-end finalize (status=200) — otherwise we can only assert a 502
  // event. Reuse upstream from the SSE suite.
  const conn = { url: new URL(`https://127.0.0.1:${upstream.port}`), key: null, auth: 'passthrough' };
  upstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SAMPLE_SSE);
  };

  // Bypass handleRequest's hard-coded route-to-MiniMax-upstream path (the
  // test env has no MINIMAX_API_KEY bound to that upstream name) by going
  // through forward() directly. This still exercises finalize()'s new
  // logEvent call, which is what the assertion targets.
  const { req, res } = makeReqResForForward();
  forward(req, res, conn, Buffer.from('{"model":"minimax"}'), {
    id: 'event-test',
    t0: Date.now() - 5,
    session: null,
    model: 'minimax',
    realModel: 'MiniMax-M3',
  });
  await new Promise((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
    setTimeout(() => reject(new Error('forward timed out after 5s')), 5000);
  });

  const eventsPath = process.env.STATS_EVENTS_FILE;
  assert.ok(existsSync(eventsPath), 'expected event file to exist');
  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, `expected at least one event, got: ${lines.length}`);
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.equal(rec.model, 'minimax');
  assert.equal(rec.real_model, 'MiniMax-M3');
  // upstream is host:port; only the host part is stable across runs.
  assert.match(rec.upstream, /^127\.0\.0\.1(:\d+)?$/);
  assert.equal(rec.status, 200);
  assert.equal(rec.sessionId, null);
});
