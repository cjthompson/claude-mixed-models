// Shared test fixtures for the router/stats integration tests.
//
// `FakeUpstream` stands up a self-signed HTTPS server on an ephemeral
// port and lets each test install a request handler via `respond = fn`.
// The two test suites that exercise the full request path
// (router/server.test.js and stats/pipeline.test.js) used to carry
// identical copies of the openssl/cert/HTTPS-server/req-res plumbing;
// this file is the single source of truth.
//
// Not imported by production code.

import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// OpenSSL recipe for a self-signed cert valid for 127.0.0.1. We shell
// out rather than depend on a TLS library so the helper has zero new
// npm dependencies.
function generateCert(certDir) {
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ]);
  return { keyPath, certPath };
}

// Stand up a fake HTTPS upstream. Lifecycle is explicit — call start()
// in a `before()` hook and stop() in `after()`. Tests set the request
// handler by writing to `upstream.respond`; the same server is reused
// across tests in a file, so per-test state lives on the `respond`
// reference, not on the server itself.
export function createFakeUpstream() {
  let server = null;
  let certDir = null;
  let port = 0;
  let respond = null;     // (req, res) => void, set by the test

  return {
    start: async () => {
      certDir = mkdtempSync(join(tmpdir(), 'fake-upstream-cert-'));
      const { keyPath, certPath } = generateCert(certDir);
      server = https.createServer(
        { key: readFileSync(keyPath), cert: readFileSync(certPath) },
        (req, res) => {
          if (respond) respond(req, res);
          else { res.writeHead(500); res.end('no test handler installed'); }
        }
      );
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
    },
    stop: async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
      }
      if (certDir) {
        rmSync(certDir, { recursive: true, force: true });
        certDir = null;
      }
    },
    // Read by tests to build the conn object: `new URL(\`https://127.0.0.1:${upstream.port}\`)`.
    get port() { return port; },
    get url() { return new URL(`https://127.0.0.1:${port}`); },
    // Each test sets this to (req, res) => { ... } to define the response
    // the upstream returns. Reset between tests by reassigning.
    set respond(fn) { respond = fn; },
    get respond() { return respond; },
  };
}

// Mock req/res pair that observes status and body, supports destroy() to
// simulate a client disconnect, and emits 'finish' on end() so callers
// can await the response. Reusable: a fresh pair is created per test
// from the factory below.
//
// The `destroy()` shim matters because the router's `forward()` calls
// `res.on('close', ...)` to detect client disconnects; the real
// http.ServerResponse fires 'close' when the socket goes away, but a
// bare Writable never does, so we wire that explicitly here.
export function makeObservableReqRes({ method = 'POST', url = '/v1/messages', host = 'router' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host };
  let statusCode = null;
  let body = '';
  const res = new Writable({ write(chunk, _enc, cb) { body += chunk.toString(); cb(); } });
  res.writeHead = (s) => { statusCode = s; return res; };
  res.headersSent = false;
  res.destroyed = false;
  res.destroy = function () {
    if (res.destroyed) return;
    res.destroyed = true;
    res.emit('close');
  };
  return {
    req,
    res,
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

// A representative Anthropic SSE response: 10 input tokens, 42 output
// tokens, 1234 cache-creation tokens, no thinking, no TTL split. The
// `forward()` tests assert the token bracket and rollup match this
// exactly, so changing the constants here will surface as failures
// (which is the point — SAMPLE_SSE is part of the test contract).
export const SAMPLE_SSE = [
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
