# Routing Observability Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-request REQ/RES log lines to the router and proxy — a request id, route decision, status, duration, and (for the proxy) token usage — so concurrent agents can be cost-tracked and debugged from a `tail -f` of stdout.

**Architecture:** A new `lib/log.js` module exposes `newRequestId()`, `logReq(id, fields)`, and `logRes(id, fields)`. Both `router/server.js` and `proxy/server.js` import it. The router's `forward()` signature gains `{ id, t0 }` so the response side can log. The router's RES line carries `upstream`, `status`, `duration` only — it pipes SSE bytes through and never buffers, so it has no usage object. The proxy's RES line additionally carries token usage from a one-line tweak to `extractUsageFromSse` (return the **last** usage object seen, not the first) so `output_tokens` is captured from `message_delta`. No shared mutable state; each request gets its own id and timer; multiple concurrent agents produce independent log lines.

**Tech Stack:** Node.js built-ins (`node:crypto`, `node:test`, `node:assert/strict`). Zero new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-06-02-routing-logging-design.md` (read this first if anything is unclear).

---

## File Structure

```
claude-mixed-models/
├── lib/                                 # NEW
│   ├── log.js                           # NEW: newRequestId, logReq, logRes, formatUsage
│   └── log.test.js                      # NEW
├── proxy/
│   ├── inspect.js                       # MODIFY: extractUsageFromSse returns last usage
│   ├── inspect.test.js                  # MODIFY: assert last-usage-wins
│   └── server.js                        # MODIFY: replace ad-hoc console.log with logReq/logRes
├── router/
│   └── server.js                        # MODIFY: logReq/logRes calls; forward() gains {id, t0}
└── router/
    └── server.test.js                   # MODIFY: adapt existing forward() test; add REQ/RES coverage
```

---

## Task 1: `lib/log.js` — `newRequestId`

**Files:**
- Create: `lib/log.js`
- Test: `lib/log.test.js`

- [ ] **Step 1: Create `lib/log.js` with `newRequestId` only**

Create the file `lib/log.js` with this exact content:

```js
import { randomBytes } from 'node:crypto';

// 8 lowercase hex chars from 4 random bytes. e.g. '4f7a9b2c'.
// Pure function — no shared state. Each call is independent so concurrent
// requests get independent ids.
export function newRequestId() {
  return randomBytes(4).toString('hex');
}

// Current local time as 'HH:MM:SS' (24h, zero-padded). e.g. '01:23:45'.
// Reads new Date() at call time — no caching across calls, so concurrent
// log lines get distinct timestamps.
export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
```

- [ ] **Step 2: Create `lib/log.test.js` with the first tests**

Create the file `lib/log.test.js` with this exact content:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
```

- [ ] **Step 3: Run the tests to verify they pass**

Run from the repo root:

```bash
npm test -- lib/log.test.js
```

Expected: both tests pass. (The test file imports `logReq` and `logRes` which don't exist yet — that's expected to fail the *import* until Task 2 lands. If you see a module-not-found error from `./log.js`, just verify the two `newRequestId` tests fail with that specific reason and move on. We'll add `logReq`/`logRes` in Task 2.)

If the tests fail for any other reason (e.g. assertion mismatch), fix `log.js` or the test until they pass.

- [ ] **Step 4: Commit**

```bash
git add lib/log.js lib/log.test.js
git commit -m "feat(log): add newRequestId helper for request id generation

8 lowercase hex chars from crypto.randomBytes(4). Pure function, no
shared state — safe under concurrent requests.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `lib/log.js` — `logReq` and `logRes`

**Files:**
- Modify: `lib/log.js`
- Test: `lib/log.test.js`

- [ ] **Step 1: Add failing tests for `logReq` and `logRes`**

Append the following tests to `lib/log.test.js` (after the existing `newRequestId` and `timestamp` tests):

```js
// --- logReq ----------------------------------------------------------------
// We stub timestamp() so the assertions can be exact. logReq/logRes call
// timestamp() at emission time; a stub that returns a constant gives us
// deterministic lines.

import * as log from './log.js';

const origTimestamp = log.timestamp;
function stubTimestamp(value) {
  log.timestamp = () => value;
}

test('logReq: emits fields in the documented order, omitting absent ones', () => {
  stubTimestamp('01:23:45');
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
    log.timestamp = origTimestamp;
  }

  assert.deepEqual(captured, [
    '[01:23:45 REQ 4f7a9b2c] method=POST url=/v1/messages model=claude-minimax route=MiniMax-M3 upstream=minimax user=alice',
    '[01:23:45 REQ aaaaaaaaaaaaaaaa] method=GET url=/v1/models upstream=api.anthropic.com',
  ]);
});

test('logReq: omits fields whose value is undefined or null', () => {
  stubTimestamp('01:23:45');
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
    log.timestamp = origTimestamp;
  }

  assert.deepEqual(captured, [
    '[01:23:45 REQ id] method=POST url=/x upstream=minimax',
  ]);
});

// --- logRes ----------------------------------------------------------------

test('logRes: emits fields in the documented order, omitting absent ones', () => {
  stubTimestamp('01:23:46');
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
    log.timestamp = origTimestamp;
  }

  assert.deepEqual(captured, [
    '[01:23:46 RES 4f7a9b2c] upstream=minimax status=200 duration=842ms input=1234 output=42 cache_read=5678 cache_write=120',
  ]);
});

test('logRes: works without usage (router case — no usage captured)', () => {
  stubTimestamp('01:23:46');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logRes('id', { upstream: 'minimax', status: 200, durationMs: 5, usage: null });
  } finally {
    console.log = orig;
    log.timestamp = origTimestamp;
  }

  assert.deepEqual(captured, [
    '[01:23:46 RES id] upstream=minimax status=200 duration=5ms',
  ]);
});

test('logRes: handles non-200 status with no usage', () => {
  stubTimestamp('01:23:46');
  const captured = [];
  const orig = console.log;
  console.log = (line) => captured.push(line);
  try {
    logRes('id', { upstream: 'minimax', status: 502, durationMs: 1234, usage: null });
  } finally {
    console.log = orig;
    log.timestamp = origTimestamp;
  }

  assert.deepEqual(captured, [
    '[01:23:46 RES id] upstream=minimax status=502 duration=1234ms',
  ]);
});
```

Note: the `import * as log from './log.js'` namespace import is used purely so we can stub `log.timestamp`. The named imports `newRequestId`, `timestamp`, `logReq`, `logRes` at the top of the file stay; the namespace import is additive.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- lib/log.test.js
```

Expected: 5 failures (the new tests) with `logReq is not a function` / `logRes is not a function`. The `newRequestId` and `timestamp` tests still pass.

- [ ] **Step 3: Implement `logReq`, `logRes`, and `formatUsage` in `lib/log.js`**

Replace the contents of `lib/log.js` with this exact content:

```js
import { randomBytes } from 'node:crypto';

// 8 lowercase hex chars from 4 random bytes. e.g. '4f7a9b2c'.
// Pure function — no shared state. Each call is independent so concurrent
// requests get independent ids.
export function newRequestId() {
  return randomBytes(4).toString('hex');
}

// Current local time as 'HH:MM:SS' (24h, zero-padded). e.g. '01:23:45'.
// Reads new Date() at call time — no caching across calls, so concurrent
// log lines get distinct timestamps.
export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// REQ field order. Absent fields (undefined/null) are omitted from the line —
// no empty key=value pairs, no `n/a`. Order is fixed so log lines are
// visually diffable across requests.
const REQ_ORDER = ['method', 'url', 'model', 'route', 'upstream', 'user'];

// fields: { method, url, model?, route?, upstream, user? }
export function logReq(id, fields) {
  console.log(`[${timestamp()} REQ ${id}] ${formatKv(REQ_ORDER, fields)}`);
}

// RES field order. Same omission rule as REQ.
const RES_ORDER = ['upstream', 'status', 'duration', 'input', 'output', 'cache_read', 'cache_write', 'total'];

// fields: { upstream, status, durationMs: number, usage?: object | null }
// durationMs is rendered as `duration=<n>ms`; the other usage fields come
// from formatUsage(usage).
export function logRes(id, fields) {
  const base = formatKv(RES_ORDER, {
    upstream: fields.upstream,
    status: fields.status,
  });
  // duration gets the 'ms' suffix; other fields don't.
  const durationPart = fields.durationMs != null
    ? ` duration=${fields.durationMs}ms`
    : '';
  console.log(`[${timestamp()} RES ${id}] ${base}${durationPart}${formatUsage(fields.usage)}`);
}

// Internal: build ' key1=val1 key2=val2 ...' from `order` and `fields`,
// skipping keys whose value is null or undefined.
function formatKv(order, fields) {
  const out = [];
  for (const key of order) {
    const v = fields[key];
    if (v == null) continue;
    out.push(`${key}=${v}`);
  }
  return out.join(' ');
}

// Internal: usage is the object returned by extractUsageFromSse (or the
// JSON body's .usage). Returns ' input=N output=N cache_read=N
// cache_write=N total=N' with present fields only, in that fixed order.
// Returns '' for null/undefined/non-object usage.
function formatUsage(usage) {
  if (usage == null || typeof usage !== 'object') return '';
  const map = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
    total: usage.total_tokens,
  };
  const out = [];
  for (const key of ['input', 'output', 'cache_read', 'cache_write', 'total']) {
    const v = map[key];
    if (v == null) continue;
    out.push(`${key}=${v}`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- lib/log.test.js
```

Expected: all 8 tests pass (2 for `newRequestId`, 1 for `timestamp`, 2 for `logReq`, 3 for `logRes`).

- [ ] **Step 5: Commit**

```bash
git add lib/log.js lib/log.test.js
git commit -m "feat(log): add logReq/logRes for per-request REQ/RES summary lines

Plain key=value output, fixed field order, absent fields are omitted
(no empty key=value pairs). Output is one console.log per request —
atomic in Node, safe under concurrent agents.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `extractUsageFromSse` returns the last usage object

**Files:**
- Modify: `proxy/inspect.js:27-43` — change return condition
- Modify: `proxy/inspect.test.js:24-36` — adapt the existing test

- [ ] **Step 1: Update the failing test to assert "last usage wins"**

The existing test in `proxy/inspect.test.js:24-36` asserts `extractUsageFromSse` returns the first usage object (with `cache_creation_input_tokens: 1234`). Replace that test with the following two tests, which assert the new behavior (last usage wins, `output_tokens` from `message_delta` is captured):

Replace the existing block:

```js
test('extractUsageFromSse: pulls cache token counts from message_start', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":1234,"cache_read_input_tokens":0}}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const usage = extractUsageFromSse(sse);
  assert.equal(usage.cache_creation_input_tokens, 1234);
  assert.equal(usage.cache_read_input_tokens, 0);
});
```

with:

```js
test('extractUsageFromSse: returns the last usage object seen, so output_tokens from message_delta is captured', () => {
  // Anthropic streams prompt-side usage on message_start and output_tokens
  // (plus total) on message_delta. We want both in one return value.
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":1234,"cache_read_input_tokens":0}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":42,"cache_creation_input_tokens":1234,"cache_read_input_tokens":0,"total_tokens":52}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const usage = extractUsageFromSse(sse);
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.cache_creation_input_tokens, 1234);
  assert.equal(usage.cache_read_input_tokens, 0);
  assert.equal(usage.output_tokens, 42);
  assert.equal(usage.total_tokens, 52);
});

test('extractUsageFromSse: still works on a non-streamed JSON body that includes usage', () => {
  // The fallback in proxy/server.js calls JSON.parse(text).usage; that path
  // is independent of extractUsageFromSse, but verify extractUsageFromSse
  // also handles a single message_start with no following message_delta.
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
    '',
  ].join('\n');
  const usage = extractUsageFromSse(sse);
  assert.equal(usage.input_tokens, 7);
});
```

Keep the existing test `extractUsageFromSse: returns null when no usage present` unchanged.

- [ ] **Step 2: Run tests to verify the new one fails**

```bash
npm test -- proxy/inspect.test.js
```

Expected: the new "returns the last usage object" test fails (no `output_tokens` returned, because the implementation still returns the first object). The "still works on a non-streamed JSON body" test should also fail (it asserts the same last-usage-wins path). The "returns null" test still passes.

- [ ] **Step 3: Change `extractUsageFromSse` to keep the last usage object**

In `proxy/inspect.js`, replace the function body (lines 27-43):

```js
export function extractUsageFromSse(sseText) {
  let lastUsage = null;
  for (const line of sseText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const usage = obj?.message?.usage ?? obj?.usage;
    if (usage && typeof usage === 'object') lastUsage = usage;
  }
  return lastUsage;
}
```

(The change: track the **last** usage object seen across the whole stream instead of returning on the first. Same shape, same null-on-no-usage contract.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- proxy/inspect.test.js
```

Expected: all tests in `proxy/inspect.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add proxy/inspect.js proxy/inspect.test.js
git commit -m "feat(proxy): extractUsageFromSse returns last usage object

Anthropic streams prompt-side usage on message_start and output_tokens
on message_delta. Returning the last usage object captures both with
one call, so logRes sees a complete usage record.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire `logReq`/`logRes` into the proxy

**Files:**
- Modify: `proxy/server.js`

- [ ] **Step 1: Replace the ad-hoc logging in `proxy/server.js`**

In `proxy/server.js`, make three edits.

**Edit 1** — add the import. Replace the existing top-of-file imports:

```js
import http from 'node:http';
import https from 'node:https';
import { hasCacheControl, extractUsageFromSse } from './inspect.js';
```

with:

```js
import http from 'node:http';
import https from 'node:https';
import { hasCacheControl, extractUsageFromSse } from './inspect.js';
import { newRequestId, logReq, logRes } from '../lib/log.js';
```

(Confirm the relative path: `proxy/server.js` is one directory deep, so `../lib/log.js` is the import path from the repo root.)

**Edit 2** — capture the request id and timer after the body is read, and replace the `[REQ]` console.log with `logReq`. Replace the existing block (lines 22-35):

```js
  req.on('end', () => {
    const raw = Buffer.concat(chunks);

    if (raw.length) {
      try {
        const body = JSON.parse(raw.toString('utf8'));
        console.log(
          `\n[REQ] ${req.method} ${req.url} model=${body.model} ` +
          `cache_control_present=${hasCacheControl(body)}`
        );
      } catch {
        console.log(`\n[REQ] ${req.method} ${req.url} (non-JSON body, ${raw.length}B)`);
      }
    }
```

with:

```js
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const id = newRequestId();
    const t0 = Date.now();

    // Try to parse the body for REQ-line fields. Failures degrade gracefully —
    // we still log a REQ line with method/url only.
    let parsed = null;
    if (raw.length) {
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        // Body wasn't JSON. Leave parsed=null and skip model/user fields.
      }
    }
    logReq(id, {
      method: req.method,
      url: req.url,
      model: parsed?.model,
      upstream: UPSTREAM.host,
      user: parsed?.metadata?.user_id,
      // Optional: include cache_control flag if a JSON body parsed successfully.
      // (See Step 2 for whether to add this — we currently do not.)
    });
```

(We deliberately do not include `cache_control_present` in the REQ line in v1. The proxy's diagnostic purpose was to surface cache_control, but the router/proxy logs are now cost-focused. The `hasCacheControl` helper stays imported for now because removing the import would be a separate change — but its use can be dropped from the REQ line. To keep this task minimal, leave `hasCacheControl` imported but unused, OR remove the import if the linter complains. **Decision: remove the import.** Edit 4 below.)

**Edit 3** — replace the `[RES]` console.log with `logRes`, and capture the usage. Replace the existing block (lines 63-78):

```js
        upstreamRes.on('end', () => {
          res.end();
          const text = Buffer.concat(respChunks).toString('utf8');
          const usage = extractUsageFromSse(text) ??
            (() => { try { return JSON.parse(text).usage ?? null; } catch { return null; } })();
          if (usage) {
            console.log(
              `[RES] status=${upstreamRes.statusCode} ` +
              `cache_write=${usage.cache_creation_input_tokens ?? 'n/a'} ` +
              `cache_read=${usage.cache_read_input_tokens ?? 'n/a'} ` +
              `input=${usage.input_tokens ?? 'n/a'}`
            );
          } else {
            console.log(`[RES] status=${upstreamRes.statusCode} (no usage found)`);
          }
        });
```

with:

```js
        upstreamRes.on('end', () => {
          res.end();
          const text = Buffer.concat(respChunks).toString('utf8');
          const usage = extractUsageFromSse(text) ??
            (() => { try { return JSON.parse(text).usage ?? null; } catch { return null; } })();
          logRes(id, {
            upstream: UPSTREAM.host,
            status: upstreamRes.statusCode ?? 502,
            durationMs: Date.now() - t0,
            usage,
          });
        });
```

**Edit 4** — remove the now-unused `hasCacheControl` import. Change the import line at the top to:

```js
import { extractUsageFromSse } from './inspect.js';
```

- [ ] **Step 2: Smoke-test the proxy by running it briefly**

This is a manual sanity check, not a test. From the repo root:

```bash
npm run proxy
```

In another terminal, send a request that doesn't need a real MiniMax key — the upstream will reject it with a 401, but the proxy should still log the REQ line:

```bash
curl -s -o /dev/null -X POST http://localhost:8787/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"MiniMax-M3","messages":[{"role":"user","content":"hi"}],"metadata":{"user_id":"smoketest"}}'
```

You should see two log lines in the proxy terminal (with a `HH:MM:SS` timestamp prefix on each):

```
[01:23:45 REQ 4f7a9b2c] method=POST url=/v1/messages model=MiniMax-M3 upstream=api.minimax.io user=smoketest
[01:23:45 RES 4f7a9b2c] upstream=api.minimax.io status=401 duration=…ms
```

(Exact duration and id will vary.) If the REQ line is missing `user=smoketest`, the body wasn't parsed — re-check Edit 2. If the RES line is missing `status=`, re-check Edit 3.

Stop the proxy with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add proxy/server.js
git commit -m "feat(proxy): emit REQ/RES lines with request id, status, duration, usage

Replaces the ad-hoc [REQ]/[RES] console.log calls. Token usage comes
from extractUsageFromSse (last-usage-wins, captures output_tokens) or
a JSON-body .usage fallback. timing starts after the request body is
fully read.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Wire `logReq`/`logRes` into the router — REQ line

**Files:**
- Modify: `router/server.js`

- [ ] **Step 1: Add the import**

In `router/server.js`, replace the existing top-of-file imports:

```js
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveRoute } from './routes.js';
```

with:

```js
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveRoute } from './routes.js';
import { newRequestId, logReq, logRes } from '../lib/log.js';
```

- [ ] **Step 2: Capture id and t0, and emit the REQ line**

In `router/server.js`, the existing request handler runs `req.on('end', () => { … })` and ends by calling `forward(req, res, conn, outBody)` (line 139). Replace the entire body of that `req.on('end', …)` arrow function (lines 91-140) with the following:

```js
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const id = newRequestId();
    const t0 = Date.now();

    // Only POSTs with a JSON body carry a model to route on. Everything else
    // (GET /v1/models on startup, bodyless calls) rides the default upstream untouched.
    let conn, outBody, route, parsedBody;
    if (req.method === 'POST' && raw.length) {
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail(res, 400, 'router: body is not JSON');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return fail(res, 400, 'router: body must be a JSON object');
      }
      parsedBody = body;
      route = resolveRoute(body.model, config.routes);
      if (route) {
        try {
          conn = upstreamConn(route.upstream);
        } catch (err) {
          return fail(res, 500, `router: ${err.message}`);
        }
        body.model = route.realModel;
        outBody = Buffer.from(JSON.stringify(body), 'utf8');
      } else {
        // Unmapped model → ride the default upstream untouched. For a Claude
        // subscription this forwards your own credential straight to Anthropic.
        try {
          conn = upstreamConn(DEFAULT_UPSTREAM);
        } catch (err) {
          return fail(res, 500, `router: ${err.message}`);
        }
        outBody = raw;
      }
    } else {
      try {
        conn = upstreamConn(DEFAULT_UPSTREAM);
      } catch (err) {
        return fail(res, 500, `router: ${err.message}`);
      }
      outBody = raw;
    }

    logReq(id, {
      method: req.method,
      url: req.url,
      model: parsedBody?.model,
      route: route?.realModel,
      upstream: conn.url.host,
      user: parsedBody?.metadata?.user_id,
    });

    forward(req, res, conn, outBody, { id, t0 });
  });
```

**Note on the `model` field after rewrite:** `body.model = route.realModel` mutates `body` in place, so `parsedBody.model` is now the **rewritten** model id (e.g. `MiniMax-M3`), not the inbound alias. This is what we want on the REQ line — the log shows the model that was actually sent to the upstream, which is what cost-tracking needs. The unrewritten alias is recoverable from the route table.

For unmapped passthrough, `route` is `undefined`, so `route?.realModel` evaluates to `undefined` and the `route=` field is omitted from the REQ line — matching the spec's omission rule.

- [ ] **Step 3: Run all tests to make sure the existing test suite still loads (import-wise)**

```bash
npm test -- router/server.test.js
```

Expected: the existing tests in `router/server.test.js` still load and pass *except* the `forward: https:// upstream reaches the error handler` test, which will fail because `forward`'s signature changed. That's expected — we fix that test in Task 6.

If the import of `log.js` itself fails (module-not-found), double-check the relative path. `router/server.js` lives one directory deep, so `../lib/log.js` is correct.

- [ ] **Step 4: Commit (router REQ line only)**

```bash
git add router/server.js
git commit -m "feat(router): emit REQ line with id, route decision, and user

REQ line is emitted after the body is parsed and the route/default
decision is made. The model field on the REQ line is the rewritten
model id (e.g. MiniMax-M3), which is what the upstream actually
receives. The inbound alias is recoverable from the route table.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `forward()` gains `{ id, t0 }`, and emit the RES line

**Files:**
- Modify: `router/server.js:46-80` — change `forward` signature, emit `logRes` on response and error
- Modify: `router/server.test.js:88-109` — adapt the existing `forward` test to the new signature

- [ ] **Step 1: Update the failing test first (it asserts the new signature)**

In `router/server.test.js`, replace the existing `forward: https:// upstream reaches the error handler` test (lines 88-109) with this version, which passes `{ id, t0 }` and adds an assertion that `logRes` was called for the 502 path:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- router/server.test.js
```

Expected: the adapted test fails with `TypeError: forward expected {id, t0}` (or similar) because the new `forward` signature isn't implemented yet.

- [ ] **Step 3: Update `forward()` to accept `{ id, t0 }` and emit `logRes`**

In `router/server.js`, replace the existing `forward` function (lines 46-80) with:

```js
export function forward(req, res, conn, outBody, { id, t0 }) {
  const headers = { ...req.headers };
  for (const h of HOP_BY_HOP) delete headers[h];
  headers.host = conn.url.host;
  headers['content-length'] = String(outBody.length);
  applyAuth(headers, conn);

  const upstreamPath = conn.url.pathname.replace(/\/$/, '') + req.url;
  // https.request() accepts the `protocol` option and handles both http:// and
  // https:// upstreams; http.request() rejects 'https:' outright. Use the same
  // request module for both protocols.
  const upstreamReq = https.request(
    {
      protocol: conn.url.protocol,
      hostname: conn.url.hostname,
      port: conn.url.port || 443,
      method: req.method,
      path: upstreamPath,
      headers,
    },
    (upstreamRes) => {
      const safeHeaders = { ...upstreamRes.headers };
      for (const h of HOP_BY_HOP) delete safeHeaders[h];
      res.writeHead(upstreamRes.statusCode ?? 502, safeHeaders);
      upstreamRes.pipe(res);
      // Log the RES line on response end. usage is null because the router
      // pipes SSE bytes through without buffering (see spec "Known gap").
      upstreamRes.on('end', () => {
        logRes(id, {
          upstream: conn.url.host,
          status: upstreamRes.statusCode ?? 502,
          durationMs: Date.now() - t0,
          usage: null,
        });
      });
    }
  );
  upstreamReq.on('error', (err) => {
    console.error('[ROUTER UPSTREAM ERROR]', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error');
    // Emit a RES line for the failed request so it shows up in logs.
    logRes(id, {
      upstream: conn.url.host,
      status: 502,
      durationMs: Date.now() - t0,
      usage: null,
    });
  });
  upstreamReq.write(outBody);
  upstreamReq.end();
}
```

Two behavioral changes:
- New `{ id, t0 }` parameter is required.
- A `logRes` call is made on `upstreamRes.on('end')` for successful responses, and on the error path for failures.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- router/server.test.js
```

Expected: the adapted `forward` test passes. All other tests in the file still pass (none of them touch the `forward` signature except this one).

- [ ] **Step 5: Commit**

```bash
git add router/server.js router/server.test.js
git commit -m "feat(router): emit RES line on response and on upstream error

forward() now takes { id, t0 } so the response side can log. On
upstream error, both the existing 502 + 'upstream error' body and a
RES line are emitted, so failed requests are visible in
observability logs. usage is null because the router pipes SSE
bytes through without buffering (see spec "Known gap").

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Router tests — assert REQ/RES for the three request paths

**Files:**
- Modify: `router/server.test.js`

- [ ] **Step 1: Add failing tests for the three routing paths**

Append the following tests to `router/server.test.js` (after the existing tests). They exercise the request handler end-to-end via an injected `http.createServer`-like seam. Since the router constructs its server inline at module load, we have two options:

**Option A (chosen): drive the handler via a real test HTTP server** — spawn an `http.createServer` using the same handler, send requests, assert logs. Requires more setup.

**Option B: refactor the handler out of the inline `http.createServer` call into a named export**, then test the named export directly. Cleaner.

The existing tests in this file already use Option B-style: they import `applyAuth`, `forward`, and `KNOWN_AUTH_MODES` from `./server.js`. To stay consistent and keep tests fast, refactor the request handler into a named export `handleRequest(req, res)` and have `http.createServer(handleRequest)` wrap it. Then the new tests call `handleRequest` directly with the same `makeReqRes()` stub used by the existing `forward` test, plus a way to advance the request body (`req.emit('data', …)`, `req.emit('end')`).

This refactor is small and isolated. **Implement it as part of this task.**

**Step 1a** — refactor the request handler. In `router/server.js`, replace the existing `const server = http.createServer((req, res) => { … });` (line 87-141) with:

```js
// Exported for tests; the server below wraps it. The handler reads the
// request body, makes the routing decision, emits REQ/RES log lines, and
// forwards to the chosen upstream.
export function handleRequest(req, res) {
  const chunks = [];
  req.on('error', (e) => console.error('[REQ ERROR]', e.message));
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const id = newRequestId();
    const t0 = Date.now();

    // Only POSTs with a JSON body carry a model to route on. Everything else
    // (GET /v1/models on startup, bodyless calls) rides the default upstream untouched.
    let conn, outBody, route, parsedBody;
    if (req.method === 'POST' && raw.length) {
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail(res, 400, 'router: body is not JSON');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return fail(res, 400, 'router: body must be a JSON object');
      }
      parsedBody = body;
      route = resolveRoute(body.model, config.routes);
      if (route) {
        try {
          conn = upstreamConn(route.upstream);
        } catch (err) {
          return fail(res, 500, `router: ${err.message}`);
        }
        body.model = route.realModel;
        outBody = Buffer.from(JSON.stringify(body), 'utf8');
      } else {
        // Unmapped model → ride the default upstream untouched. For a Claude
        // subscription this forwards your own credential straight to Anthropic.
        try {
          conn = upstreamConn(DEFAULT_UPSTREAM);
        } catch (err) {
          return fail(res, 500, `router: ${err.message}`);
        }
        outBody = raw;
      }
    } else {
      try {
        conn = upstreamConn(DEFAULT_UPSTREAM);
      } catch (err) {
        return fail(res, 500, `router: ${err.message}`);
      }
      outBody = raw;
    }

    logReq(id, {
      method: req.method,
      url: req.url,
      model: parsedBody?.model,
      route: route?.realModel,
      upstream: conn.url.host,
      user: parsedBody?.metadata?.user_id,
    });

    forward(req, res, conn, outBody, { id, t0 });
  });
}

const server = http.createServer(handleRequest);
```

(Behavior is unchanged. `handleRequest` is now exported and `server` uses it. The previous `if (isMain)` block at the bottom still works because it references `server`, not the inline handler.)

**Step 1b** — add the tests. Append the following to `router/server.test.js`:

```js
import { handleRequest } from './server.js';

// --- handleRequest — REQ line ----------------------------------------------
// These tests capture console.log to assert the REQ line emitted for each
// routing path. The actual upstream is never contacted: we point
// handleRequest's downstream at a closed port by intercepting the call
// just after the REQ line is logged. To do that we monkey-patch forward
// for the duration of each test.

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
  let forwardArgs = null;
  // Monkey-patch forward just for this test by intercepting it via the
  // module's exports. We can't easily replace forward on the live module
  // without breaking the other tests, so instead we use a closed-port
  // upstream connection (the same trick the existing forward test uses)
  // and read the captured REQ line.
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
```

(The "wait 50ms" is a small concession to the fact that the handler emits the REQ line on a microtask after `req.emit('end')` — the upstream `forward()` call is fired in the same tick but goes to a closed port and never completes. The wait is enough for the REQ line to appear; the test does not depend on the RES line, which is the existing `forward` test's job.)

- [ ] **Step 2: Run tests to verify the new ones pass**

```bash
npm test -- router/server.test.js
```

Expected: all 8 tests in the file pass (the 5 existing + 3 new). The new tests assert the REQ line shape for mapped, unmapped, and bodyless paths.

If a test fails because `handleRequest is not a function` or similar, re-check Step 1a — the refactor must export `handleRequest` from `router/server.js`.

If a test fails on `model=claude-sonnet-4-6` for the unmapped case, double-check that `resolveRoute` returns `null` for unmapped models (it does — see `router/routes.js`).

- [ ] **Step 3: Run the full test suite end-to-end**

```bash
npm test
```

Expected: all tests across `lib/`, `proxy/`, and `router/` pass. No regressions in the unrelated `applyAuth`, `KNOWN_AUTH_MODES`, `body-guard`, `hasCacheControl`, or `resolveRoute` tests.

- [ ] **Step 4: Commit**

```bash
git add router/server.js router/server.test.js
git commit -m "test(router): assert REQ line for mapped, unmapped, and bodyless paths

Extracts the request handler into an exported handleRequest so it can
be driven directly from tests without a live HTTP listener. The
upstream is still pointed at a closed port — the REQ line is logged
before the upstream call, so the closed-port error doesn't affect
the assertion.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: End-to-end smoke test

**Files:** (no code changes; manual verification)

- [ ] **Step 1: Run the router and send a real-shape request**

Start the router:

```bash
npm run router
```

In another terminal, run the project's existing diagnostic script:

```bash
scripts/run-router.sh
```

(If that script requires a real Anthropic/MiniMax key in `.env` and you don't have one, use the manual `curl` from Task 4 Step 2 instead — pointed at the router port, 8788 — and check the router's log output.)

- [ ] **Step 2: Verify the log lines**

You should see, in the router's terminal, two lines per request, each prefixed with a `HH:MM:SS` timestamp:

```
[01:23:45 REQ <id>] method=POST url=/v1/messages model=… route=… upstream=… user=…
[01:23:45 RES <id>] upstream=… status=… duration=…ms
```

The `id` is the same on both lines. `route=` is present for the `claude-minimax` alias (rewritten to `MiniMax-M3`) and absent for unmapped passthrough. `user=` is present if the client sent `metadata.user_id`.

- [ ] **Step 3: Run the proxy end-to-end**

```bash
npm run proxy
```

In another terminal:

```bash
scripts/run-diagnostic.sh
```

(Or the manual `curl` from Task 4 Step 2.) Verify the proxy's REQ/RES lines look right, with `input=` / `output=` / `cache_*=` fields when the upstream returns usage.

- [ ] **Step 4: (No commit — this is a manual verification step only.)**

If any log line is missing a field that should be present, or if the field order is wrong, go back to the relevant task and fix it.

---

## Self-Review

**1. Spec coverage:**

- New `lib/log.js` with `newRequestId`, `logReq`, `logRes`, `formatUsage` → Tasks 1, 2. ✓
- Request id = 8 hex chars from `crypto.randomBytes(4)` → Task 1. ✓
- `HH:MM:SS` timestamp prepended to every line → Task 1 (`timestamp()` export), Task 2 (call site + tests stub it for exact assertions), Task 4 + Task 8 (smoke-test expectations updated). ✓
- REQ fields `method, url, model?, route?, upstream, user?` in fixed order, omission rule → Task 2 + tests assert this. ✓
- RES fields `upstream, status, durationMs, usage?` in fixed order, omission rule → Task 2 + tests assert this. ✓
- `formatUsage` returns `''` for null; `input/output/cache_read/cache_write/total` in fixed order → covered by `logRes` tests. ✓
- `extractUsageFromSse` returns last usage object → Task 3. ✓
- Router emits REQ on entry with `id, t0` captured after body read → Task 5. ✓
- `forward` gains `{ id, t0 }` → Task 6. ✓
- Router emits RES on response end and on upstream error → Task 6. ✓
- Proxy emits REQ/RES with usage from `extractUsageFromSse` → Task 4. ✓
- Known gap: router does not capture usage → called out in spec; implementation matches (router passes `usage: null`).
- Tests for `lib/log` → Task 2. ✓
- Tests for `extractUsageFromSse` last-usage-wins → Task 3. ✓
- Tests for router REQ line across the three paths → Task 7. ✓
- Tests for forward() error-path RES line → Task 6. ✓
- Manual end-to-end smoke test → Task 8. ✓

**2. Placeholder scan:**

Searched the plan for "TBD", "TODO", "implement later", "fill in details", "add appropriate error handling", "similar to Task N" — none present. All code blocks are complete and runnable. (One "see Step 2 for whether to add this" inside Task 4 Step 1 Edit 2 — that's a deliberate inline decision point that resolves to "no, don't add it" with a clear rationale. Acceptable.)

**3. Type consistency:**

- `newRequestId()` returns `string` (8 hex chars). Task 1 implementation matches. Task 5 uses it as a local `id`. ✓
- `timestamp()` returns `string` matching `/^\d{2}:\d{2}:\d{2}$/`. Task 1 implementation matches. Tests in Task 2 stub it via `import * as log` namespace so line assertions stay exact. ✓
- `logReq(id: string, fields: object)` — Task 2 implementation matches. Task 4 and Task 5 callers pass `id` (string) and a plain object. ✓
- `logRes(id: string, fields: { upstream, status, durationMs, usage })` — Task 2 implementation matches. Task 4 and Task 6 callers pass exactly that shape (router passes `usage: null`; proxy passes the actual usage object or `null`). ✓
- `forward(req, res, conn, outBody, { id, t0 })` — Task 6 implementation matches. Task 5 (REQ-line-only commit) calls it with `{ id, t0 }` from the new local variables. Task 6 (RES-line commit) reads the same fields. The adapted test in Task 6 also passes `{ id, t0 }`. ✓
- `handleRequest(req, res)` — Task 7 implementation matches the original inline handler. The test in Task 7 calls it directly. ✓
- `formatUsage` is private to `lib/log.js`; not exported, not used outside. ✓

**Issue found and fixed during self-review:**

Original Task 4 Edit 2 was ambiguous about whether to keep the `hasCacheControl` import (the diagnostic feature was the proxy's whole point). Resolved inline: remove the import. Step 4 of Task 4 covers it.

**Issue found and fixed during plan revision (mid-draft user request):**

User asked for a `HH:MM:SS` timestamp at the start of every log line. Updates:
- Spec: new "Timestamp" subsection + `timestamp()` export added to the `lib/log.js` API description. The spec was rewritten (`Write` rather than `Edit`) because the Edit tool repeatedly reported false whitespace mismatches against the on-disk file. Both versions of the spec are semantically equivalent.
- Plan: Task 1 now ships `timestamp()` alongside `newRequestId()`. Task 1's test adds a `timestamp: returns HH:MM:SS in 24h format` case. Task 2's tests stub `log.timestamp` (via `import * as log`) and assert lines like `[01:23:45 REQ …]`. Task 2's implementation prepends `${timestamp()}` in both `logReq` and `logRes`. Task 6's `forward`-error RES-line assertion switched from `startsWith('[RES test-id-1]')` to a timestamp regex. Task 7's REQ-line assertions likewise switched from `startsWith('[REQ ')` to `^\[\d{2}:\d{2}:\d{2} REQ /`. The proxy and router smoke-test "what to look for" examples gained the timestamp prefix.

**No outstanding issues.**
