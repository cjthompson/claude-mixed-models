import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Importing server.js has the side effect of binding ROUTER_PORT (default
// 8788) via the createServer() at the bottom of the module. ESM imports
// are hoisted, so we can't set process.env before they evaluate — the
// env must be in place *before* the import statement runs. The clean way
// to do that is a dynamic import inside a before() hook. The other env
// vars the tests need (MINIMAX_API_KEY placeholder so upstreamConn()
// doesn't throw, ROUTER_PORT=0 so listen() picks an ephemeral port) are
// set here too.
process.env.MINIMAX_API_KEY ||= 'test-key-not-used';
process.env.ROUTER_PORT ||= '0';
// The new forward() tests below stand up a self-signed HTTPS upstream and
// point the router at it. We trust that cert only inside the test process.
process.env.NODE_TLS_REJECT_UNAUTHORIZED ||= '0';

let applyAuth, forward, handleRequest, KNOWN_AUTH_MODES, applyToolCompat, installShutdown;
before(async () => {
  ({ applyAuth, forward, handleRequest, KNOWN_AUTH_MODES, applyToolCompat, installShutdown } = await import('./server.js'));
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

function makeReqRes() {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/v1/messages';
  req.headers = { host: 'router' };

  let statusCode = null;
  let body = '';
  const res = new Writable({
    write(chunk, _enc, cb) { body += chunk.toString(); cb(); },
  });
  res.writeHead = (s) => { statusCode = s; return res; };
  res.headersSent = false;
  return { req, res, getStatus: () => statusCode, getBody: () => body };
}

test('forward: https:// upstream reaches the error handler (regression: ERR_INVALID_PROTOCOL)', async () => {
  const conn = { url: new URL('https://127.0.0.1:1'), key: null, auth: 'passthrough' };
  const { req, res, getStatus, getBody } = makeReqRes();

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

// Generate a self-signed cert for 127.0.0.1. OpenSSL is available on every
// dev machine we care about; if it isn't, the test run will fail with a
// clear spawn error rather than a confusing TLS handshake.
let fakeUpstream = null;   // { server, port }
let certDir = null;
let fakeServerCounter = 0; // unique baseUrl per test so req.url paths line up

before(async () => {
  // Wait for the dynamic import in the earlier before() to finish so we
  // have `forward` available. (node:test runs before hooks sequentially.)
  certDir = mkdtempSync(join(tmpdir(), 'router-test-cert-'));
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);
  // Stand up one long-lived HTTPS server; each test installs a fresh
  // request handler via fakeUpstream.respond = (req, res) => ... so the
  // routes/responses are scoped to the test that set them.
  fakeUpstream = {
    server: https.createServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (req, res) => {
        if (fakeUpstream.respond) {
          fakeUpstream.respond(req, res);
        } else {
          res.writeHead(500);
          res.end('no test handler installed');
        }
      }
    ),
  };
  await new Promise((resolve) => fakeUpstream.server.listen(0, '127.0.0.1', resolve));
  fakeUpstream.port = fakeUpstream.server.address().port;
});

after(async () => {
  if (fakeUpstream) {
    await new Promise((resolve) => fakeUpstream.server.close(resolve));
  }
  if (certDir) {
    rmSync(certDir, { recursive: true, force: true });
  }
});

// Build a req/res pair that observes status and body, but lets the test
// simulate a client-side disconnect by calling res.destroy().
function makeObservableReqRes() {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = `/v1/messages-${++fakeServerCounter}`;   // unique per test
  req.headers = { host: 'router' };
  let statusCode = null;
  let body = '';
  const res = new Writable({
    write(chunk, _enc, cb) { body += chunk.toString(); cb(); },
  });
  res.writeHead = (s) => { statusCode = s; return res; };
  res.headersSent = false;
  res.destroyed = false;
  // Real http.ServerResponse implements destroy() to abort the connection.
  // The Writable in our test harness never fires 'close' on its own, so we
  // emit it explicitly when destroy() is called.
  res.destroy = function () {
    if (res.destroyed) return;
    res.destroyed = true;
    res.emit('close');
  };
  return { req, res, getStatus: () => statusCode, getBody: () => body };
}

const SAMPLE_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":1234,"cache_read_input_tokens":0}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":42,"cache_creation_input_tokens":1234,"cache_read_input_tokens":0,"total_tokens":52}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

test('forward: SSE stream — extracts usage from message_delta and emits a token bracket on the RES line', async () => {
  const conn = { url: new URL(`https://127.0.0.1:${fakeUpstream.port}`), key: null, auth: 'passthrough' };
  fakeUpstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SAMPLE_SSE);
  };

  const { req, res, getStatus, getBody } = makeObservableReqRes();
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
  const conn = { url: new URL(`https://127.0.0.1:${fakeUpstream.port}`), key: null, auth: 'passthrough' };
  const jsonBody = JSON.stringify({
    id: 'msg_01', type: 'message', role: 'assistant', content: [],
    usage: { input_tokens: 100, output_tokens: 9, total_tokens: 109 },
  });
  fakeUpstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(jsonBody);
  };

  const { req, res } = makeObservableReqRes();
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
  assert.match(stripped, /\[in: 100 \| out: 9\]/);
  assert.match(stripped, /total: 109/);
});

test('forward: no usage in response — RES line omits the token bracket, no crash', async () => {
  const conn = { url: new URL(`https://127.0.0.1:${fakeUpstream.port}`), key: null, auth: 'passthrough' };
  fakeUpstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // ping event with no usage anywhere.
    res.end('event: ping\ndata: {}\n\n');
  };

  const { req, res } = makeObservableReqRes();
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
  const conn = { url: new URL(`https://127.0.0.1:${fakeUpstream.port}`), key: null, auth: 'passthrough' };
  // The handler writes the message_start event, then a slow trickle, then
  // never ends on its own — only the destroy() in the test will close the
  // response. We capture only the upstream *request* close (which fires
  // when the router calls upstreamReq.destroy()); the server-side response
  // close isn't observed because nothing in this test asserts on it.
  let reqDestroyed = false;
  fakeUpstream.respond = (req, res) => {
    req.on('close', () => { reqDestroyed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n');
    // No res.end() — the test will destroy the client to trigger the
    // router's res.on('close') path, which should call upstreamReq.destroy().
  };

  const { req, res } = makeObservableReqRes();
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
  const conn = { url: new URL(`https://127.0.0.1:${fakeUpstream.port}`), key: null, auth: 'passthrough' };
  fakeUpstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end();
  };

  const { req, res, getStatus, getBody } = makeObservableReqRes();
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

// --- installShutdown: graceful + force SIGTERM -----------------------------
// The router is meant to drain in-flight streaming responses on SIGTERM
// instead of killing them. We exercise the state machine directly with a
// stub server and stub exit so we don't actually kill the test process.
// installShutdown also wires `process.on('SIGTERM', ...)` — that's fine
// in tests because we drive the handler through the returned `onSigterm`
// reference rather than sending a real signal.

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
    handle.onSigterm();
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
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('installShutdown: zero connections on SIGTERM — exits cleanly', async () => {
  // The server must be listening when SIGTERM fires; that's the only
  // configuration installShutdown is meant to support. We bind to an
  // ephemeral port; by the time the test calls onSigterm the set is empty.
  const srv = http.createServer();
  const exitCalls = [];
  const handle = installShutdown(srv, { exit: (code) => exitCalls.push(code) });
  const cap = captureConsoleLog();
  try {
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    handle.onSigterm();
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
    handle.onSigterm();
    assert.deepEqual(exitCalls, []);

    // Second SIGTERM — force path. Should destroy the remaining socket
    // and call exit(0).
    handle.onSigterm();
    assert.deepEqual(exitCalls, [0]);
    assert.equal(destroyed, true, 'force path should destroy remaining socket');
    assert.ok(
      cap.lines.some((l) => /\[shutdown\] received second SIGTERM, forcing immediate shutdown \(1 connection\(s\) still open\)/.test(l)),
      `expected force log, got: ${JSON.stringify(cap.lines)}`
    );

    client.destroy();
  } finally {
    cap.restore();
    await new Promise((resolve) => srv.close(resolve));
  }
});
