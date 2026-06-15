// Shared test fixtures for the router/stats integration tests.
//
// `FakeUpstream` stands up a self-signed HTTPS server on an ephemeral
// port and lets each test install a request handler via `respond = fn`.
// The two test suites that exercise the full request path
// (router/server.test.js and stats/pipeline.test.js) used to carry
// identical copies of the HTTPS-server/req-res plumbing;
// this file is the single source of truth.
//
// Not imported by production code.

import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

// Pre-generated self-signed RSA-2048 cert for 127.0.0.1 (SAN: IP:127.0.0.1).
// Valid until 2036-06-12. Tests set NODE_TLS_REJECT_UNAUTHORIZED=0 so cert
// validation is disabled; the only requirement is that TLS terminates. Using
// a static cert eliminates the openssl subprocess, tmpdir I/O, and the
// dependency on openssl being on PATH at test time.
//
// To regenerate: openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
//   -days 3650 -nodes -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1'
const STATIC_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDntJ5hSCylePQj
FLfPK6581jK133BtcDqNm8Nbr0XRgGSSEGR8RKMh5D5c0HIfWryZBE43hVV73WNN
Kpl3E4M2wGFIGvOiCiXjoxaKrtjZWrwZg4WanhxO+zOdEEFh0CtCndcondt1xLmZ
ezXhWveu+yvzg4YOLNMM8Y+FShQL7eRk7mxgymYaU4TshLSRIA1s6/1sKs30sge3
sXqNMzGkzTaHqVO8A+ubOhmFD/5cy2iOTIeHXELOJbpvLYRYsCwozqbCg3YQWw5R
efXeZAdlds/zkfGilYw8fTLqVW0Ci1lLwVHj+QdLSk1zgFUG7teTdXQU6UfOY4dt
x4uLG6/nAgMBAAECggEAZi3jrljqv2owl4vaZzUHNKwtHsFTTh+w4qPvKe6IZpQt
RbCO77JBEoAZ9EpEGYmlJAGfEKLvCLmfwfboSHfFZI7AF9Ey4aGCBfn0xeHHZUq7
KrEyaPYS282xfDEf9Ced/DmpGZNLpYrEomeQYjoAghzny/KTWorv44RfW1NItd0y
1SukM6TToonnTmOcHgHwaLmBo2SZ8rNfE/ZAuTHgx1PmOKQe/PY4KqColKYyTgpb
Y0r0ZSuz9kJttf8DyUljKCyDLFIgIfbU3V0jaToK5s5vH70vGxUmjYMPHzD93BBM
hzCHEDVZD/Zo8nG0vhPpSoJB22tVJHr+vq5ovPdYgQKBgQD+zwX1LGlepqfnaq+d
XZEJBd9jjWRnNB0g2KQjO780piW8pawsnoss68ySFgjYHAb1VfZEs+vM+Si54TMf
F5kxJYFFrZF8wYHhv9glFcOGYffwoWhqodLN1mfi0Aeed70MNE8sf6z4wo8+Lo5d
6HoUmoJnlXyv/f/f4sx6u5mdpwKBgQDoyfGPMGbPkIiDWO/Bzna79RXPWsqSBSNt
G9Kd0o81ZkjlcETjAa7Nk52m2YTHxflvDRcLpkExmbnZ6/9bmvx935lrqxv5QQoP
2+MgVSS7gNJtx6HIVf9O1B5cJ/GojO4qlgYRyrCeBO5SGBMS/xf2uZoszhtINd0B
MiBjihIjwQKBgCdUxVKm3Ezj5J7v9NORkcWWxniTZqAXhzd+uTdHDaiOzNxlpkHs
5wa0DwutowfYq6pK7oyESS2GeCbZAA8YkWjopR+gPwjGxcmW10JCLcAcdy0JfRiY
ifWD1t1HxyVKzj+IA4CW5JgxT/MFNKyCKfXsM5zRkkGIL2rbkzyOoJOZAoGAMxlx
Lw9e4h1F+h8hshdSNPwdp4C0is0Z869x0jcQPJaRVdwJIxORfYrzxlZlMT0h/eCP
uHzsPqkSBOYrDb69whu9H8dVwqcmQEjyWHyYLZifmH2D4+gMvQ8PAwe5olgdR7fa
6TjnACjw75BdT4QzjHM9hqxPjNBWDRclyPPb+4ECgYEAwU8yUYIPrBDsHHp26iWd
5f4DcaCsDcn0Dcu9SxGQzNtfUZriFrCcXQgnbmMJZybnMM813bHnBFcYHG6B2xRv
nF4/bg5omiKn0ToHvw7dMjMTtuhmP1ldK2yB1TwDSJY/7yNxlSvqjSw9p3Wss1c3
iYaSrsJBMPPWxU8mVkrH5SE=
-----END PRIVATE KEY-----`;

const STATIC_CERT = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUdS9oR4wKoEQD8G80mpUrJCFzgjIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDYxNTAzMDkzMFoXDTM2MDYx
MjAzMDkzMFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA57SeYUgspXj0IxS3zyuufNYytd9wbXA6jZvDW69F0YBk
khBkfESjIeQ+XNByH1q8mQRON4VVe91jTSqZdxODNsBhSBrzogol46MWiq7Y2Vq8
GYOFmp4cTvsznRBBYdArQp3XKJ3bdcS5mXs14Vr3rvsr84OGDizTDPGPhUoUC+3k
ZO5sYMpmGlOE7IS0kSANbOv9bCrN9LIHt7F6jTMxpM02h6lTvAPrmzoZhQ/+XMto
jkyHh1xCziW6by2EWLAsKM6mwoN2EFsOUXn13mQHZXbP85HxopWMPH0y6lVtAotZ
S8FR4/kHS0pNc4BVBu7Xk3V0FOlHzmOHbceLixuv5wIDAQABo2QwYjAdBgNVHQ4E
FgQUEPY3tvuWnLpHVDcqYHVcdtrckVwwHwYDVR0jBBgwFoAUEPY3tvuWnLpHVDcq
YHVcdtrckVwwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQBWlmuw1R4AzKfUGebmKRz+HW7lisYMr3z3y7HVbnRykAZj
5KF0OHLwpz9NED35gNy3dSfw2J8IwX064nJhOGVdy80X3b0G/7BhILadaf0aqABa
2BXXLYTgkp0un7gfEDeHDZceh2Fl1Qj+GeS6Zg2xEFT0sibM1rEyH1eKoQt0qF1a
IIfeG/9Q6jXpJTlzTBTxf1VECqZ1ntkWIWRdPu8ctOcI6XrPj04qtL1O5lotX8Ra
l5N9r9vRu0jqC6giSsKNWhU97d8dCGos2sNw53zDnMObx3iwkoIIAfPa0SYwHkSA
+7hRq/H3B2QevtmvZuTshGDwPI9qeLsK8eRZZm+u
-----END CERTIFICATE-----`;


// Stand up a fake HTTPS upstream. Lifecycle is explicit — call start()
// in a `before()` hook and stop() in `after()`. Tests set the request
// handler by writing to `upstream.respond`; the same server is reused
// across tests in a file, so per-test state lives on the `respond`
// reference, not on the server itself.
export function createFakeUpstream() {
  let server = null;
  let port = 0;
  let respond = null;     // (req, res) => void, set by the test

  return {
    start: async () => {
      server = https.createServer(
        { key: STATIC_KEY, cert: STATIC_CERT },
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
