import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { applyAuth, forward, KNOWN_AUTH_MODES } from './server.js';

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
