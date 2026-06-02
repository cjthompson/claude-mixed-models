import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { applyAuth, forward, handleRequest, KNOWN_AUTH_MODES } from './server.js';

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
  // in observability logs.
  const resLine = captured.find((l) => /^\[\d{2}:\d{2}:\d{2} RES test-id-1\]/.test(l));
  assert.ok(resLine, `expected a RES line for the failed request, got: ${JSON.stringify(captured)}`);
  assert.match(resLine, /status=502/);
  assert.match(resLine, /upstream=127\.0\.0\.1/);
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
    const req = makePostReq({ model: 'claude-minimax', messages: [], metadata: { user_id: 'u1' } });
    const res = new Writable({ write(c, _e, cb) { cb(); } });
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
  assert.match(reqLine, /method=POST/);
  assert.match(reqLine, /url=\/v1\/messages/);
  // The model field on the REQ line is the rewritten one (MiniMax-M3).
  assert.match(reqLine, /model=MiniMax-M3/);
  assert.match(reqLine, /route=MiniMax-M3/);
  assert.match(reqLine, /upstream=api\.minimax\.io/);
  assert.match(reqLine, /user=u1/);
});

test('handleRequest: REQ line for unmapped model omits route and shows the default upstream', async () => {
  const cap = captureLog();
  try {
    const req = makePostReq({ model: 'claude-sonnet-4-6', messages: [] });
    const res = new Writable({ write(c, _e, cb) { cb(); } });
    res.writeHead = () => res;
    res.headersSent = false;
    handleRequest(req, res);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    cap.restore();
  }

  const reqLine = cap.lines.find((l) => /^\[\d{2}:\d{2}:\d{2} REQ /.test(l));
  assert.ok(reqLine, `expected a REQ line, got: ${JSON.stringify(cap.lines)}`);
  assert.match(reqLine, /method=POST/);
  // For passthrough, model is whatever the body said and route is absent.
  assert.match(reqLine, /model=claude-sonnet-4-6/);
  assert.doesNotMatch(reqLine, /route=/);
  assert.match(reqLine, /upstream=api\.anthropic\.com/);
});

test('handleRequest: REQ line for a bodyless GET omits model and route', async () => {
  const cap = captureLog();
  try {
    const req = makeGetReq('/v1/models');
    const res = new Writable({ write(c, _e, cb) { cb(); } });
    res.writeHead = () => res;
    res.headersSent = false;
    handleRequest(req, res);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    cap.restore();
  }

  const reqLine = cap.lines.find((l) => /^\[\d{2}:\d{2}:\d{2} REQ /.test(l));
  assert.ok(reqLine, `expected a REQ line, got: ${JSON.stringify(cap.lines)}`);
  assert.match(reqLine, /method=GET/);
  assert.match(reqLine, /url=\/v1\/models/);
  assert.doesNotMatch(reqLine, /model=/);
  assert.doesNotMatch(reqLine, /route=/);
  assert.doesNotMatch(reqLine, /user=/);
  assert.match(reqLine, /upstream=api\.anthropic\.com/);
});
