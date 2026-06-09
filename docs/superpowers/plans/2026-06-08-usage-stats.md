# Usage Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-hosted usage stats system (JSONL write buffer → SQLite rollups → HTML dashboard + CLI) that surfaces model usage, time-of-day, token, cache, and session statistics from the router's existing log stream.

**Architecture:** Router appends one JSON object per request to a transient `router.events.jsonl` buffer. A batcher worker (spawned by a single stats plist orchestrator) consumes the buffer on every `fs.watch` change (with a 10s safety timer), recomputes 5m/1h/1d rollups from the raw `events` table, and truncates the buffer on success. An HTTP worker (sibling of the batcher under the same orchestrator) serves a vanilla-JS dashboard + JSON API from the SQLite file (read-only, WAL). The CLI imports the worker modules directly — no orchestrator required for one-shot or watch use.

**Tech Stack:** Node 22.5+ (for built-in `node:sqlite`), `node:http`, `node:fs.watch`, `chart.js` (vendored). No new dependencies.

---

## File Structure

**New files:**
- `lib/event.js` — pure event sink (`logEvent`); mkdirs parent, try/catch append
- `lib/event.test.js` — unit tests
- `stats/schema.sql` — DDL (events table + 3 rollup tables; WAL pragmas)
- `stats/queries.mjs` — pure data layer; one fn per dashboard card
- `stats/queries.test.js` — in-memory DatabaseSync tests
- `stats/workers/batcher.mjs` — long-running worker; fs.watch + recompute rollups
- `stats/workers/batcher.test.js` — fs + sqlite integration
- `stats/workers/server.mjs` — long-running worker; read-only HTTP
- `stats/workers/server.test.js` — fetch + assert JSON
- `stats/public/index.html` — dashboard shell
- `stats/public/app.js` — fetch + render cards
- `stats/public/style.css` — layout + color palette
- `stats/public/chart.min.js` — vendored chart.js, pinned version
- `bin/stats-cli.mjs` — one-shot + `--watch` CLI
- `scripts/server.mjs` — orchestrator (~30 lines)
- `scripts/com.claude-mixed-models.stats.plist` — service
- `scripts/install-services.sh` — install both plists

**Modified files:**
- `router/server.js` — one new call to `logEvent` inside `finalize()`; capture `real_model` in `forward()`'s opts; capture `cwd` once at startup (or skip — see Task 1)
- `package.json` — `"stats": "node bin/stats-cli.mjs"`, `"engines": { "node": ">=22.5" }`
- `.env.example` — `STATS_PORT`, `STATS_EVENTS_FILE`, `STATS_DB_PATH`
- `CHANGELOG.md` — entry under `## 2026-06-08`
- `README.md` — short section linking to `docs/operations/stats-services.md`

**New docs:**
- `docs/operations/stats-services.md` — install/launch/logs for the new plist

---

## Task 1: Add `lib/event.js` event sink

**Files:**
- Create: `lib/event.js`
- Test: `lib/event.test.js`

- [ ] **Step 1: Write the failing test**

Create `lib/event.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logEvent } from './event.js';

test('logEvent: writes a single JSON line with the timestamp field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const path = join(dir, 'events.jsonl');
  try {
    logEvent({ path, id: 'aaaaaaaa', model: 'minimax' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.id, 'aaaaaaaa');
    assert.equal(rec.model, 'minimax');
    assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logEvent: creates the parent directory if missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const path = join(dir, 'nested', 'events.jsonl');
  try {
    logEvent({ path, id: 'bbbbbbbb' });
    assert.ok(existsSync(path), 'expected file to exist after mkdir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logEvent: does not throw on a bad path (e.g. unwritable)', () => {
  // /dev/null/foo is not a valid path; appendFileSync will fail.
  // The function must swallow the error so it never breaks the router.
  assert.doesNotThrow(() => logEvent({ path: '/dev/null/foo/events.jsonl', id: 'cccccccc' }));
});

test('logEvent: appends multiple lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const path = join(dir, 'events.jsonl');
  try {
    logEvent({ path, id: '1' });
    logEvent({ path, id: '2' });
    logEvent({ path, id: '3' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l) => JSON.parse(l).id), ['1', '2', '3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/event.test.js 2>&1 | tail -20`
Expected: FAIL with "Cannot find module './event.js'"

- [ ] **Step 3: Implement `lib/event.js`**

Create `lib/event.js`:

```js
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_PATH = '/tmp/claude-mixed-models/router.events.jsonl';

// Best-effort: a failed append must never throw on the router's response path.
// `path` is overridden in tests; production callers omit it and the env var
// (or default) is used.
export function logEvent(fields) {
  const path = fields.path ?? process.env.STATS_EVENTS_FILE ?? DEFAULT_PATH;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ...fields, path: undefined, ts: new Date().toISOString() }) + '\n');
  } catch (err) {
    // Drop the event and log to stderr. The router's response path is sacred.
    console.error('[stats] logEvent failed (dropping event):', err.message);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/event.test.js 2>&1 | tail -10`
Expected: 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/event.js lib/event.test.js
git commit -m "feat(log): add best-effort JSONL event sink in lib/event.js"
```

---

## Task 2: Wire `logEvent` into `router/server.js` `finalize()`

**Files:**
- Modify: `router/server.js:74-91,215-275`
- Test: `router/server.test.js`

- [ ] **Step 1: Add the `real_model` import + thread it through `forward()`**

In `router/server.js`, find the `forward` function signature (line 74):

```js
export function forward(req, res, conn, outBody, { id, t0, session }) {
```

Replace with:

```js
export function forward(req, res, conn, outBody, { id, t0, session, model, realModel }) {
```

- [ ] **Step 2: Update each of the three `finalize({...})` call sites to include `model` and `real_model`**

In the same file, find the three `finalize({...})` invocations and add `model` and `real_model` to each. The empty-body path (around line 139), the normal-end path (around line 154), the client-close path (around line 169), and the upstream-error path (around line 182) all need this. Example for the normal-end path:

```js
finalize({
  upstream: conn.url.host,
  status: upstreamStatus,
  durationMs: Date.now() - t0,
  usage,
  session,
  model,
  real_model: realModel,
});
```

Do the same for the other three (empty-body, client-close, upstream-error). For the 499/502/empty paths, `usage` is `null` and the four token fields default to 0; that's correct — the event still records the failure.

- [ ] **Step 3: Add the `logEvent` import**

In `router/server.js`, at the top of the file, add to the import block (around line 8):

```js
import { logEvent } from '../lib/event.js';
```

- [ ] **Step 4: Add the `logEvent` call inside `finalize()`**

Find the `finalize` closure (around line 88). Replace it with:

```js
let done = false;
const finalize = (fields) => {
  if (done) return;
  done = true;
  logRes(id, fields);
  // Best-effort event sink. Fire-and-forget; errors are swallowed inside logEvent.
  logEvent({
    id,
    model: fields.model,
    real_model: fields.real_model,
    upstream: fields.upstream,
    status: fields.status,
    durationMs: fields.durationMs,
    sessionId: fields.session,
    input_tokens: fields.usage?.input_tokens ?? 0,
    output_tokens: fields.usage?.output_tokens ?? 0,
    cache_read_input_tokens: fields.usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: fields.usage?.cache_creation_input_tokens ?? 0,
  });
};
```

`finalize` is the only place every request exits, and the `done` flag already dedupes — so exactly one event is emitted per request, on every path (200, 499, 502, empty-body).

- [ ] **Step 5: Update `handleRequest` to pass `model` and `realModel` into `forward()`**

In `handleRequest` (around line 215), the routing decision is made before `forward` is called. Find the call to `forward(req, res, conn, outBody, { id, t0, session })` (around line 274). Replace the `forward` call so it captures `model` and `realModel` and passes them in.

The current code is roughly:

```js
const session = sessionIdFromUserId(parsedBody?.metadata?.user_id);
logReq(id, { ... });
forward(req, res, conn, outBody, { id, t0, session });
```

Replace the line where `outBody` is set, to also capture the alias. In the mapped-route branch (around line 245), `body.model` is reassigned to `route.realModel`. We need to capture the *original* alias before that reassignment. Restructure the `handleRequest` flow so the alias is captured once:

```js
// ... existing routing logic ...
let originalModel = parsedBody?.model;
let realModel = null;
if (route) {
  // ... existing route.apply ...
  realModel = route.realModel;
  // ... existing body.model = route.realModel ...
}
const session = sessionIdFromUserId(parsedBody?.metadata?.user_id);
logReq(id, { ... });
forward(req, res, conn, outBody, { id, t0, session, model: originalModel, realModel });
```

The exact form depends on the existing code shape — read the file first, preserve the existing logic, and add the two new locals + pass them through.

- [ ] **Step 6: Update existing router tests to assert the new event file is not created in the unit-test path**

In `router/server.test.js`, the existing tests exercise `handleRequest` with a mock upstream. With the new `logEvent` call inside `finalize()`, every test that exercises a successful request will now write to `STATS_EVENTS_FILE` (or the default `/tmp/claude-mixed-models/...`). To keep tests hermetic, set the env var in a `before` hook to a `mkdtempSync` path, and `rmSync` the directory in an `after` hook.

Add to the top of `router/server.test.js` (after the existing imports):

```js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let statsDir;
test.beforeEach(() => {
  statsDir = mkdtempSync(join(tmpdir(), 'router-stats-'));
  process.env.STATS_EVENTS_FILE = join(statsDir, 'events.jsonl');
});
test.afterEach(() => {
  delete process.env.STATS_EVENTS_FILE;
  rmSync(statsDir, { recursive: true, force: true });
});
```

The existing `handleRequest` tests should still pass — they don't assert anything about the event file. We're just preventing stray writes to `/tmp`.

- [ ] **Step 7: Add a new test that asserts the event file gets a line for a successful request**

Append to `router/server.test.js`:

```js
test('handleRequest: writes a JSONL event line on successful completion', async () => {
  const eventsPath = process.env.STATS_EVENTS_FILE;
  const req = makePostReq({ model: 'minimax', messages: [], metadata: { user_id: '{"session_id":"abc"}' } });
  const res = new Writable({ write(c, _e, cb) { cb(); } });
  res.writeHead = () => res;
  res.headersSent = false;
  handleRequest(req, res);
  await new Promise((r) => setTimeout(r, 50));
  // The mock upstream returns 200 with no usage; the event still gets logged.
  const { readFileSync, existsSync } = await import('node:fs');
  assert.ok(existsSync(eventsPath), 'expected event file to exist');
  const lines = readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, `expected at least one event, got: ${lines.length}`);
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.equal(rec.model, 'minimax');
  assert.equal(rec.real_model, 'MiniMax-M3');
  assert.equal(rec.upstream, 'api.minimax.io');
  assert.equal(rec.status, 200);
  assert.equal(rec.sessionId, 'abc');
});
```

- [ ] **Step 8: Run the router tests**

Run: `node --test router/server.test.js 2>&1 | tail -30`
Expected: all existing tests pass; the new test passes

- [ ] **Step 9: Commit**

```bash
git add router/server.js router/server.test.js
git commit -m "feat(router): emit JSONL events from finalize() covering all exit paths"
```

---

## Task 3: Create `stats/schema.sql`

**Files:**
- Create: `stats/schema.sql`

- [ ] **Step 1: Write the schema file**

Create `stats/schema.sql`:

```sql
-- SQLite schema for the usage-stats service.
-- Loaded by stats/workers/batcher.mjs on first open; idempotent.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;     -- safe with WAL; ~2x faster than FULL

-- Raw events: one row per router request.
-- (id, ts) is the primary key, not id alone, so a retried JSONL line
-- (same id, same timestamp) is silently dropped while a genuine
-- 32-bit id collision requires an exact-ms match to dedup.
CREATE TABLE IF NOT EXISTS events (
  id                          TEXT NOT NULL,
  ts                          TEXT NOT NULL,
  model                       TEXT NOT NULL,   -- client-requested alias
  real_model                  TEXT NOT NULL,   -- resolved upstream model
  upstream                    TEXT NOT NULL,
  status                      INTEGER NOT NULL,
  duration_ms                 INTEGER NOT NULL,
  session_id                  TEXT,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, ts)
);

CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_model    ON events(model);
CREATE INDEX IF NOT EXISTS idx_events_upstream ON events(upstream);
CREATE INDEX IF NOT EXISTS idx_events_session  ON events(session_id);

-- 5-minute rollup. The card queries primarily read from this.
-- Recomputed from `events` on every batcher pass (never incremented),
-- so a retried pass produces identical values.
CREATE TABLE IF NOT EXISTS rollup_5m (
  bucket_start  TEXT NOT NULL,   -- ISO 8601, top of 5-min window (UTC)
  model         TEXT NOT NULL,
  upstream      TEXT NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  p50_ms        INTEGER,
  p95_ms        INTEGER,
  PRIMARY KEY (bucket_start, model, upstream)
);
CREATE INDEX IF NOT EXISTS idx_5m_bucket ON rollup_5m(bucket_start);

-- Hourly rollup. Drives the 7-day "tokens/day" and cache-hit-rate cards.
CREATE TABLE IF NOT EXISTS rollup_1h (
  bucket_start  TEXT NOT NULL,
  model         TEXT NOT NULL,
  upstream      TEXT NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  p50_ms        INTEGER,
  p95_ms        INTEGER,
  PRIMARY KEY (bucket_start, model, upstream)
);
CREATE INDEX IF NOT EXISTS idx_1h_bucket ON rollup_1h(bucket_start);

-- Daily rollup. Drives the 30-day "tokens/day" card.
CREATE TABLE IF NOT EXISTS rollup_1d (
  bucket_start  TEXT NOT NULL,   -- 'YYYY-MM-DD' (UTC)
  model         TEXT NOT NULL,
  upstream      TEXT NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  p50_ms        INTEGER,
  p95_ms        INTEGER,
  PRIMARY KEY (bucket_start, model, upstream)
);
CREATE INDEX IF NOT EXISTS idx_1d_bucket ON rollup_1d(bucket_start);
```

- [ ] **Step 2: Commit**

```bash
git add stats/schema.sql
git commit -m "feat(stats): add SQLite schema with events + 3 rollup tables"
```

---

## Task 4: Create `stats/queries.mjs` (data layer)

**Files:**
- Create: `stats/queries.mjs`
- Test: `stats/queries.test.js`

- [ ] **Step 1: Write the failing test**

Create `stats/queries.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  tokensByDay,
  requestsByHourOfDay,
  cacheHitRateByModel,
  topModels,
  topSessions,
  errorsByStatus,
  todaysTotals,
} from './queries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, 'schema.sql'), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  // Seed: 2 days, 2 models, mix of statuses and tokens.
  const insert = db.prepare(`
    INSERT INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                       input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Day 1: 2026-06-07
  insert.run('a1', '2026-06-07T10:00:00.000Z', 'minimax',     'MiniMax-M3',  'api.minimax.io',    200, 1000, 's1', 100, 10, 0, 0);
  insert.run('a2', '2026-06-07T11:00:00.000Z', 'minimax',     'MiniMax-M3',  'api.minimax.io',    200, 2000, 's1', 200, 20, 0, 0);
  insert.run('a3', '2026-06-07T12:00:00.000Z', 'claude-opus', 'claude-opus', 'api.anthropic.com', 502,  500, 's1',   0,  0, 0, 0);
  // Day 2: 2026-06-08
  insert.run('b1', '2026-06-08T10:00:00.000Z', 'minimax',     'MiniMax-M3',  'api.minimax.io',    200, 1500, 's2', 300, 30, 50, 0);
  insert.run('b2', '2026-06-08T11:00:00.000Z', 'claude-opus', 'claude-opus', 'api.anthropic.com', 200, 2500, 's2', 400, 40, 0, 0);
  return db;
}

test('tokensByDay: returns one row per day, summed by model', () => {
  const rows = tokensByDay(freshDb(), '7d');
  // Two days, each row totals across all models for that day.
  const byDate = Object.fromEntries(rows.map((r) => [r.date, r.tokens]));
  assert.equal(byDate['2026-06-07'], 100 + 200 + 0);    // 300
  assert.equal(byDate['2026-06-08'], 300 + 400);          // 700
});

test('requestsByHourOfDay: returns 24 buckets aggregated over the window', () => {
  const rows = requestsByHourOfDay(freshDb(), '7d');
  assert.equal(rows.length, 24);
  assert.equal(rows[10].requests, 2);   // 10:00 on both days
  assert.equal(rows[11].requests, 2);   // 11:00 on both days
  assert.equal(rows[12].requests, 1);   // 12:00 only on day 1
  assert.equal(rows[0].requests, 0);    // 00:00 untouched
});

test('cacheHitRateByModel: returns ratio of cache_read to total input', () => {
  const rows = cacheHitRateByModel(freshDb(), '7d');
  const byModel = Object.fromEntries(rows.map((r) => [r.model, r.hitRate]));
  // minimax: 0 cache reads out of 100+200+300 = 600 input → 0
  // claude-opus: 0 cache reads out of 0+400 = 400 input → 0
  assert.equal(byModel['minimax'], 0);
  assert.equal(byModel['claude-opus'], 0);
});

test('topModels: returns models ordered by total input_tokens desc', () => {
  const rows = topModels(freshDb(), '7d');
  assert.equal(rows[0].model, 'minimax');          // 100+200+300 = 600
  assert.equal(rows[1].model, 'claude-opus');      // 0+400 = 400
  assert.equal(rows[0].requests, 3);
  assert.equal(rows[1].requests, 2);
});

test('topSessions: returns sessions ordered by request count desc', () => {
  const rows = topSessions(freshDb(), '7d');
  assert.equal(rows[0].session_id, 's1');
  assert.equal(rows[0].requests, 3);
  assert.equal(rows[1].session_id, 's2');
  assert.equal(rows[1].requests, 2);
});

test('errorsByStatus: returns counts of status >= 400 in the last 24h', () => {
  // The seed data is older than 24h relative to "now"; expect zero rows.
  const rows = errorsByStatus(freshDb(), '24h');
  assert.deepEqual(rows, []);
});

test('todaysTotals: returns 0 rows for days that are not "today" (UTC)', () => {
  // Seed data is in early June 2026; "today" in a future test run will be different.
  // We just assert the function runs and returns a single object with the expected keys.
  const row = todaysTotals(freshDb());
  assert.equal(typeof row.requests, 'number');
  assert.equal(typeof row.input_tokens, 'number');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test stats/queries.test.js 2>&1 | tail -10`
Expected: FAIL with "Cannot find module './queries.mjs'"

- [ ] **Step 3: Implement `stats/queries.mjs`**

Create `stats/queries.mjs`:

```js
// Pure data layer: one function per dashboard card.
// All functions take a `DatabaseSync` and a `range` string ('24h' | '7d' | '30d' | 'all').
// No formatting, no HTTP, no I/O. Both the HTTP server and the CLI call these.

// Range → SQLite datetime threshold (UTC). Returns the ISO string for `WHERE ts >= ?`.
// 'all' returns no threshold (caller handles the no-filter case).
function rangeThreshold(range) {
  const now = new Date();
  switch (range) {
    case '24h': now.setUTCDate(now.getUTCDate() - 1); break;
    case '7d':  now.setUTCDate(now.getUTCDate() - 7); break;
    case '30d': now.setUTCDate(now.getUTCDate() - 30); break;
    case 'all': return null;
    default: throw new Error(`unknown range: ${range}`);
  }
  return now.toISOString();
}

function withRange(range, whereClause = '1=1') {
  const t = rangeThreshold(range);
  return t ? `${whereClause} AND ts >= ?` : whereClause;
}

function bindRange(range, ...rest) {
  const t = rangeThreshold(range);
  return t ? [...rest, t] : rest;
}

// Stacked bar chart, 30 days, by model. The rollup already aggregates by day.
export function tokensByDay(db, range = '30d') {
  // Read from rollup_1d for the 30d case, rollup_1h for shorter windows.
  if (range === '30d' || range === 'all') {
    return db.prepare(`
      SELECT bucket_start AS date, model, SUM(input_tokens + output_tokens) AS tokens
      FROM rollup_1d
      GROUP BY date, model
      ORDER BY date, model
    `).all();
  }
  return db.prepare(`
    SELECT substr(bucket_start, 1, 10) AS date, model, SUM(input_tokens + output_tokens) AS tokens
    FROM rollup_1h
    ${withRange(range, '1=1')}
    GROUP BY date, model
    ORDER BY date, model
  `).all(...bindRange(range));
}

// 24-bucket bar chart of requests by hour-of-day, aggregated over the window.
export function requestsByHourOfDay(db, range = '7d') {
  const rows = db.prepare(`
    SELECT strftime('%H', bucket_start) AS hour, SUM(requests) AS requests
    FROM rollup_1h
    ${withRange(range, '1=1')}
    GROUP BY hour
  `).all(...bindRange(range));
  // Fill missing hours with 0 so the chart has 24 bars.
  const byHour = Object.fromEntries(rows.map((r) => [Number(r.hour), Number(r.requests)]));
  return Array.from({ length: 24 }, (_, h) => ({ hour: h, requests: byHour[h] ?? 0 }));
}

// Cache hit rate: cache_read / (input + cache_read + cache_creation) per model.
export function cacheHitRateByModel(db, range = '7d') {
  return db.prepare(`
    SELECT model,
           CASE WHEN SUM(input_tokens + cache_read + cache_creation) > 0
                THEN CAST(SUM(cache_read) AS REAL) / SUM(input_tokens + cache_read + cache_creation)
                ELSE 0 END AS hitRate
    FROM rollup_1h
    ${withRange(range, '1=1')}
    GROUP BY model
    ORDER BY hitRate DESC
  `).all(...bindRange(range));
}

export function topModels(db, range = '7d', limit = 5) {
  return db.prepare(`
    SELECT model,
           SUM(requests) AS requests,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(errors) AS errors
    FROM rollup_1h
    ${withRange(range, '1=1')}
    GROUP BY model
    ORDER BY input_tokens DESC
    LIMIT ?
  `).all(...bindRange(range), limit);
}

export function topSessions(db, range = '7d', limit = 5) {
  return db.prepare(`
    SELECT session_id,
           COUNT(*) AS requests,
           SUM(input_tokens + output_tokens) AS tokens,
           MIN(ts) AS first_ts,
           MAX(ts) AS last_ts
    FROM events
    WHERE session_id IS NOT NULL ${withRange(range, '')}
    GROUP BY session_id
    ORDER BY requests DESC
    LIMIT ?
  `).all(...bindRange(range), limit);
}

export function errorsByStatus(db, range = '24h') {
  return db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM events
    WHERE status >= 400 ${withRange(range, '')}
    GROUP BY status
    ORDER BY count DESC
  `).all(...bindRange(range));
}

export function todaysTotals(db) {
  const today = new Date().toISOString().slice(0, 10);   // 'YYYY-MM-DD' (UTC)
  return db.prepare(`
    SELECT
      SUM(requests)      AS requests,
      SUM(input_tokens)  AS input_tokens,
      SUM(output_tokens) AS output_tokens
    FROM rollup_1d
    WHERE bucket_start = ?
  `).get(today) ?? { requests: 0, input_tokens: 0, output_tokens: 0 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test stats/queries.test.js 2>&1 | tail -15`
Expected: 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add stats/queries.mjs stats/queries.test.js
git commit -m "feat(stats): add queries.mjs data layer with one fn per card"
```

---

## Task 5: Create `stats/workers/batcher.mjs`

**Files:**
- Create: `stats/workers/batcher.mjs`
- Test: `stats/workers/batcher.test.js`

- [ ] **Step 1: Write the failing test**

Create `stats/workers/batcher.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { readFileSync as readFile } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFile(join(here, '..', 'schema.sql'), 'utf8');

// We import the batcher's runOnce() so we can drive a single pass without spawning a process.
import { runOnce } from './batcher.mjs';

function freshPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-test-'));
  return {
    dir,
    jsonlPath: join(dir, 'events.jsonl'),
    dbPath:   join(dir, 'stats.db'),
    cleanup:  () => rmSync(dir, { recursive: true, force: true }),
  };
}

function appendEvent(jsonlPath, rec) {
  fs.appendFileSync(jsonlPath, JSON.stringify(rec) + '\n');
}
import * as fs from 'node:fs';

test('runOnce: reads all lines from JSONL, inserts into events, truncates file', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    fs.writeFileSync(jsonlPath, [
      JSON.stringify({ id: 'a', ts: '2026-06-08T10:00:00.000Z', model: 'minimax', real_model: 'MiniMax-M3', upstream: 'api.minimax.io', status: 200, durationMs: 1000, sessionId: 's1', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      JSON.stringify({ id: 'b', ts: '2026-06-08T10:01:00.000Z', model: 'minimax', real_model: 'MiniMax-M3', upstream: 'api.minimax.io', status: 200, durationMs: 2000, sessionId: 's1', input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ].join('\n') + '\n');

    await runOnce({ jsonlPath, dbPath, schema });

    const db = new DatabaseSync(dbPath);
    const events = db.prepare('SELECT id, input_tokens FROM events ORDER BY id').all();
    assert.equal(events.length, 2);
    assert.equal(events[0].input_tokens, 100);
    assert.equal(events[1].input_tokens, 200);

    const rollup = db.prepare(`SELECT requests, input_tokens FROM rollup_5m WHERE model='minimax'`).get();
    assert.equal(rollup.requests, 2);
    assert.equal(rollup.input_tokens, 300);

    // JSONL must be truncated.
    const after = fs.readFileSync(jsonlPath, 'utf8');
    assert.equal(after, '');
  } finally {
    cleanup();
  }
});

test('runOnce: retried line (same id+ts) is deduped by INSERT OR IGNORE', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    const rec = { id: 'dup', ts: '2026-06-08T10:00:00.000Z', model: 'minimax', real_model: 'MiniMax-M3', upstream: 'api.minimax.io', status: 200, durationMs: 1000, sessionId: 's1', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    fs.writeFileSync(jsonlPath, JSON.stringify(rec) + '\n');
    await runOnce({ jsonlPath, dbPath, schema });
    // JSONL is truncated; re-add the same line and run again.
    fs.writeFileSync(jsonlPath, JSON.stringify(rec) + '\n');
    await runOnce({ jsonlPath, dbPath, schema });

    const db = new DatabaseSync(dbPath);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE id='dup'`).get().c;
    assert.equal(count, 1);

    // Rollup must not double-count.
    const rollup = db.prepare(`SELECT requests FROM rollup_5m WHERE model='minimax'`).get();
    assert.equal(rollup.requests, 1);
  } finally {
    cleanup();
  }
});

test('runOnce: skips malformed lines and continues', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    fs.writeFileSync(jsonlPath, [
      'not json at all',
      JSON.stringify({ id: 'good', ts: '2026-06-08T10:00:00.000Z', model: 'minimax', real_model: 'MiniMax-M3', upstream: 'api.minimax.io', status: 200, durationMs: 1000, sessionId: 's1', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ].join('\n') + '\n');

    await runOnce({ jsonlPath, dbPath, schema });

    const db = new DatabaseSync(dbPath);
    const events = db.prepare('SELECT id FROM events').all();
    assert.equal(events.length, 1);
    assert.equal(events[0].id, 'good');
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test stats/workers/batcher.test.js 2>&1 | tail -10`
Expected: FAIL with "Cannot find module './batcher.mjs'"

- [ ] **Step 3: Implement `stats/workers/batcher.mjs`**

Create `stats/workers/batcher.mjs`:

```js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

const JSONL_PATH = process.env.STATS_EVENTS_FILE ?? '/tmp/claude-mixed-models/router.events.jsonl';
const DB_PATH    = process.env.STATS_DB_PATH ?? `${process.env.HOME}/.local/state/claude-mixed-models/router.stats.db`;
const SCHEMA_PATH = new URL('../schema.sql', import.meta.url).pathname;

// Compute the start of the 5m/1h/1d bucket a given timestamp falls into.
function bucketStart(tsIso, grain) {
  const d = new Date(tsIso);
  if (grain === '1d') {
    return d.toISOString().slice(0, 10);   // 'YYYY-MM-DD'
  }
  const minutes = grain === '5m' ? 5 : 60;
  const m = d.getUTCMinutes();
  const floored = Math.floor(m / minutes) * minutes;
  d.setUTCMinutes(floored, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

function bucketEnd(bucketIso, grain) {
  const d = new Date(bucketIso);
  if (grain === '1d') {
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const minutes = grain === '5m' ? 5 : 60;
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

// Compute p50 and p95 of an array of numbers in-place (sorting is fine; buckets are small).
function percentiles(arr) {
  if (arr.length === 0) return { p50: null, p95: null };
  const sorted = [...arr].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: p(0.5), p95: p(0.95) };
}

// Recompute one rollup row from the events table.
function recomputeRollup(db, grain, bucketStartIso, model, upstream) {
  const bucketEndIso = bucketEnd(bucketStartIso, grain);
  const rows = db.prepare(`
    SELECT duration_ms, status, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
    FROM events
    WHERE ts >= ? AND ts < ? AND model = ? AND upstream = ?
  `).all(bucketStartIso, bucketEndIso, model, upstream);
  const requests = rows.length;
  const errors = rows.filter((r) => r.status >= 400).length;
  const input_tokens  = rows.reduce((s, r) => s + r.input_tokens, 0);
  const output_tokens = rows.reduce((s, r) => s + r.output_tokens, 0);
  const cache_read    = rows.reduce((s, r) => s + r.cache_read_input_tokens, 0);
  const cache_write   = rows.reduce((s, r) => s + r.cache_creation_input_tokens, 0);
  const { p50, p95 } = percentiles(rows.map((r) => r.duration_ms));
  db.prepare(`
    INSERT INTO rollup_${grain} (bucket_start, model, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, p50_ms, p95_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bucket_start, model, upstream) DO UPDATE SET
      requests = excluded.requests,
      errors = excluded.errors,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read = excluded.cache_read,
      cache_write = excluded.cache_write,
      p50_ms = excluded.p50_ms,
      p95_ms = excluded.p95_ms
  `).run(bucketStartIso, model, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, p50, p95);
}

// One pass: read all lines, insert events, recompute touched rollup buckets, truncate.
export async function runOnce({ jsonlPath = JSONL_PATH, dbPath = DB_PATH, schemaPath = SCHEMA_PATH } = {}) {
  // Read lines first, before opening the DB — if reading fails, the JSONL is unchanged.
  let lines;
  try {
    const text = readFileSync(jsonlPath, 'utf8');
    lines = text.split('\n').filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return { inserted: 0, truncated: false };
    throw err;
  }
  if (lines.length === 0) return { inserted: 0, truncated: false };

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(schemaPath, 'utf8'));

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                                  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const touched = new Set();   // `${grain}|${bucketStart}|${model}|${upstream}`
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      // The router uses 'cache_creation_input_tokens' / 'cache_read_input_tokens' / 'sessionId'.
      // Normalize to the column names used in the schema.
      const result = insertEvent.run(
        rec.id, rec.ts, rec.model, rec.real_model, rec.upstream, rec.status, rec.durationMs,
        rec.sessionId ?? null,
        rec.input_tokens ?? 0, rec.output_tokens ?? 0,
        rec.cache_read_input_tokens ?? 0, rec.cache_creation_input_tokens ?? 0,
      );
      if (result.changes > 0) {
        inserted++;
        for (const grain of ['5m', '1h', '1d']) {
          touched.add(`${grain}|${bucketStart(rec.ts, grain)}|${rec.model}|${rec.upstream}`);
        }
      }
    }
    for (const key of touched) {
      const [grain, bs, model, upstream] = key.split('|');
      recomputeRollup(db, grain, bs, model, upstream);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Truncate only after a successful commit. If truncate fails, the next pass will
  // re-process — INSERT OR IGNORE plus recompute-from-events makes that safe.
  writeFileSync(jsonlPath, '');
  return { inserted, truncated: true };
}

// Long-running mode: fs.watch with a 10s safety timer. Re-arms on every flush.
async function mainLoop() {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT',  () => { stopping = true; });

  const tick = async () => {
    if (stopping) process.exit(0);
    try {
      await runOnce();
    } catch (err) {
      console.error('[stats-batcher] runOnce error:', err.message);
    }
  };

  // Watch the file; tick on every 'change' AND on a 10s safety timer.
  try {
    watch(JSONL_PATH, { persistent: true }, () => { tick(); });
  } catch {
    // File may not exist yet; the 10s timer will pick up the first events.
  }
  setInterval(tick, 10_000);
  await tick();   // immediate first pass in case there's a backlog
}

// `runOnce` is exported for tests. If invoked directly (as the entry point), start the main loop.
if (import.meta.url === `file://${process.argv[1]}`) {
  mainLoop().catch((err) => {
    console.error('[stats-batcher] fatal:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test stats/workers/batcher.test.js 2>&1 | tail -20`
Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add stats/workers/batcher.mjs stats/workers/batcher.test.js
git commit -m "feat(stats): add batcher worker with idempotent recompute rollups"
```

---

## Task 6: Create `stats/workers/server.mjs`

**Files:**
- Create: `stats/workers/server.mjs`
- Test: `stats/workers/server.test.js`

- [ ] **Step 1: Write the failing test**

Create `stats/workers/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.mjs';

test('startServer: GET /api/stats returns JSON for a populated DB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-test-'));
  const dbPath = join(dir, 'stats.db');
  try {
    // Seed a small DB.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(join(here, '..', 'schema.sql'), 'utf8');
    const db = new DatabaseSync(dbPath);
    db.exec(schema);
    const insert = db.prepare(`
      INSERT INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                         input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('x1', new Date().toISOString(), 'minimax', 'MiniMax-M3', 'api.minimax.io', 200, 1000, 's1', 100, 10, 0, 0);
    db.close();

    const port = 18789 + Math.floor(Math.random() * 1000);
    const { url, close } = await startServer({ dbPath, port, publicDir: join(here, '..', 'public') });
    try {
      const res = await fetch(`${url}/api/stats?range=7d`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok('tokensByDay' in json);
      assert.ok('requestsByHourOfDay' in json);
      assert.ok('cacheHitRateByModel' in json);
      assert.ok('topModels' in json);
      assert.ok('topSessions' in json);
      assert.ok('errorsByStatus' in json);
      assert.ok('todaysTotals' in json);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startServer: GET / serves the dashboard HTML', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-test-'));
  const dbPath = join(dir, 'stats.db');
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(join(here, '..', 'schema.sql'), 'utf8');
    const db = new DatabaseSync(dbPath);
    db.exec(schema);
    db.close();

    const port = 18789 + Math.floor(Math.random() * 1000);
    const { url, close } = await startServer({ dbPath, port, publicDir: join(here, '..', 'public') });
    try {
      const res = await fetch(`${url}/`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /<html/i);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startServer: read-only WAL connection sees writes from a separate writer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-test-'));
  const dbPath = join(dir, 'stats.db');
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(join(here, '..', 'schema.sql'), 'utf8');
    // Writer: create the DB.
    const writer = new DatabaseSync(dbPath);
    writer.exec(schema);
    writer.close();

    // Read-only server.
    const port = 18789 + Math.floor(Math.random() * 1000);
    const { url, close } = await startServer({ dbPath, port, publicDir: join(here, '..', 'public') });
    try {
      // Open another writer and commit a row AFTER the read-only server is up.
      const w2 = new DatabaseSync(dbPath);
      w2.exec(`
        INSERT INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                            input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
        VALUES ('wal-test', '${new Date().toISOString()}', 'minimax', 'MiniMax-M3', 'api.minimax.io', 200, 1000, 's', 100, 10, 0, 0);
      `);
      w2.close();

      // Allow a moment for WAL to flush.
      await new Promise((r) => setTimeout(r, 50));

      const res = await fetch(`${url}/api/stats?range=7d`);
      const json = await res.json();
      const found = json.topSessions.find((r) => r.session_id === 's');
      assert.ok(found, `expected to find session 's' in topSessions: ${JSON.stringify(json.topSessions)}`);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test stats/workers/server.test.js 2>&1 | tail -10`
Expected: FAIL with "Cannot find module './server.mjs'"

- [ ] **Step 3: Implement `stats/workers/server.mjs`**

Create `stats/workers/server.mjs`:

```js
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  tokensByDay,
  requestsByHourOfDay,
  cacheHitRateByModel,
  topModels,
  topSessions,
  errorsByStatus,
  todaysTotals,
} from '../queries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH  = process.env.STATS_DB_PATH  ?? `${process.env.HOME}/.local/state/claude-mixed-models/router.stats.db`;
const DEFAULT_PORT     = Number(process.env.STATS_PORT ?? 8789);
const DEFAULT_PUBLIC_DIR = join(here, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// Open a fresh read-only connection per request. Cheap with `node:sqlite` (no connection
// pooling), and ensures the reader always sees the latest committed state under WAL.
function query(dbPath, range, fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return fn(db, range);
  } finally {
    db.close();
  }
}

function buildApiHandler(dbPath) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const range = url.searchParams.get('range') ?? '7d';
    if (!['24h', '7d', '30d', 'all'].includes(range)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown range: ${range}` }));
      return;
    }
    try {
      const payload = {
        range,
        tokensByDay:          query(dbPath, range, tokensByDay),
        requestsByHourOfDay:  query(dbPath, range, requestsByHourOfDay),
        cacheHitRateByModel:  query(dbPath, range, cacheHitRateByModel),
        topModels:            query(dbPath, range, topModels),
        topSessions:          query(dbPath, range, topSessions),
        errorsByStatus:       query(dbPath, range, errorsByStatus),
        // todaysTotals takes no range arg ("today" is always "today" in UTC).
        todaysTotals:         query(dbPath, 'all', todaysTotals),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      console.error('[stats-server] query error:', err.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  };
}

function buildStaticHandler(publicDir) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    // Prevent path traversal: strip `..` segments.
    if (path.includes('..')) {
      res.writeHead(400); res.end('bad path'); return;
    }
    const fullPath = join(publicDir, path);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) { res.writeHead(404); res.end('not found'); return; }
      const data = readFileSync(fullPath);
      const type = MIME[extname(fullPath)] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  };
}

// Exported for tests; the production bottom-of-module call starts the server.
export async function startServer({ dbPath = DEFAULT_DB_PATH, port = DEFAULT_PORT, publicDir = DEFAULT_PUBLIC_DIR, host = '127.0.0.1' } = {}) {
  const apiHandler    = buildApiHandler(dbPath);
  const staticHandler = buildStaticHandler(publicDir);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) apiHandler(req, res);
    else staticHandler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host}:${port}`;
  const close = () => new Promise((resolve) => server.close(() => resolve()));
  return { url, close, server };
}

// Install graceful shutdown when run as the main module.
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then(({ url }) => {
    console.log(`[stats-server] dashboard at ${url}`);
    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT',  () => process.exit(0));
  }).catch((err) => {
    console.error('[stats-server] fatal:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify they pass**

Run: `node --test stats/workers/server.test.js 2>&1 | tail -20`
Expected: 3 tests pass

(The tests will pass even without `stats/public/` existing — the static handler returns 404 for missing assets but `/` still serves `index.html` once it exists in Task 8. The tests only assert the API and the `/` endpoint shape, not the specific dashboard assets.)

- [ ] **Step 5: Commit**

```bash
git add stats/workers/server.mjs stats/workers/server.test.js
git commit -m "feat(stats): add HTTP server worker serving dashboard + JSON API"
```

---

## Task 7: Create the dashboard (`stats/public/`)

**Files:**
- Create: `stats/public/index.html`
- Create: `stats/public/app.js`
- Create: `stats/public/style.css`
- Create: `stats/public/chart.min.js` (vendored, pinned)

- [ ] **Step 1: Download and vendor `chart.min.js`**

Check what version of chart.js is the current stable v4 release. As of this writing, that's v4.4.x. Download the UMD build:

```bash
mkdir -p stats/public
curl -fsSL https://cdn.jsdelivr.net/npm/chart.js@4.4.6/dist/chart.umd.min.js -o stats/public/chart.min.js
```

Verify the file is non-trivial (it's minified, ~200KB):

```bash
ls -la stats/public/chart.min.js
```

Expected: a file around 200KB.

- [ ] **Step 2: Write `stats/public/index.html`**

Create `stats/public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Usage stats</title>
  <link rel="stylesheet" href="style.css">
  <script src="chart.min.js"></script>
</head>
<body>
  <header>
    <h1>Usage stats</h1>
    <select id="range">
      <option value="24h">Last 24h</option>
      <option value="7d" selected>Last 7 days</option>
      <option value="30d">Last 30 days</option>
      <option value="all">All time</option>
    </select>
  </header>
  <main>
    <section class="card" id="card-totals">
      <h2>Today</h2>
      <div class="totals" id="totals"></div>
    </section>
    <section class="card">
      <h2>Tokens per day</h2>
      <canvas id="chart-tokens" height="120"></canvas>
    </section>
    <section class="card">
      <h2>Requests by hour-of-day</h2>
      <canvas id="chart-hours" height="120"></canvas>
    </section>
    <section class="card">
      <h2>Cache hit rate by model</h2>
      <canvas id="chart-cache" height="120"></canvas>
    </section>
    <section class="card">
      <h2>Top models</h2>
      <table id="table-models"><thead><tr><th>Model</th><th>Reqs</th><th>In</th><th>Out</th><th>Errors</th></tr></thead><tbody></tbody></table>
    </section>
    <section class="card">
      <h2>Top sessions</h2>
      <table id="table-sessions"><thead><tr><th>Session</th><th>Reqs</th><th>Tokens</th></tr></thead><tbody></tbody></table>
    </section>
    <section class="card">
      <h2>Errors (last 24h)</h2>
      <table id="table-errors"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody></tbody></table>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `stats/public/style.css`**

Create `stats/public/style.css`:

```css
:root {
  --bg: #1a1a1a;
  --card-bg: #242424;
  --fg: #e0e0e0;
  --muted: #888;
  --accent: #4a86e8;
  --error: #fb4c2f;
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: -apple-system, system-ui, sans-serif; margin: 0; }
header {
  padding: 1rem 1.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #333;
}
header h1 { margin: 0; font-size: 1.25rem; font-weight: 500; }
header select { background: var(--card-bg); color: var(--fg); border: 1px solid #444; padding: 0.4rem 0.6rem; border-radius: 4px; }
main {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 1rem;
  padding: 1rem;
}
.card { background: var(--card-bg); border-radius: 6px; padding: 1rem 1.2rem; }
.card h2 { margin: 0 0 0.8rem 0; font-size: 0.95rem; font-weight: 500; color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th, td { padding: 0.4rem 0.5rem; text-align: left; border-bottom: 1px solid #333; }
th { color: var(--muted); font-weight: 500; }
.totals { display: flex; gap: 1.5rem; }
.totals > div { display: flex; flex-direction: column; }
.totals .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
.totals .value { font-size: 1.4rem; font-weight: 500; }
.session-swatch { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; margin-right: 0.4rem; vertical-align: middle; }
```

- [ ] **Step 4: Write `stats/public/app.js`**

Create `stats/public/app.js`:

```js
// djb2 hash of the first 8 characters of a string, matching __colorEscapeForModel.
function hashModel(s) {
  let h = 5381;
  const len = Math.min(s.length, 8);
  for (let i = 0; i < len; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}
const SESSION_COLORS = [33, 36, 32, 35, 34, 31, 37, 208, 129, 46, 196, 220];
function modelColor(s) {
  const c = SESSION_COLORS[hashModel(s) % SESSION_COLORS.length];
  return c < 38 ? `ansi(${c})` : `#${c.toString(16).padStart(6, '0')}`;
}
// Tailwind/ansi: map small codes to actual hex; for simplicity in v1 use the 256-palette directly.
function modelHex(s) {
  const c = SESSION_COLORS[hashModel(s) % SESSION_COLORS.length];
  // 256-palette codes >= 38 are not direct hex; map to a fixed 12-color cycle.
  const cycle = ['#a479e2', '#4a86e8', '#16a766', '#fad165', '#ffad47', '#fb4c2f', '#999999', '#f691b3', '#43d692', '#ff7537', '#7bd3f7', '#b9e4d0'];
  return cycle[hashModel(s) % cycle.length];
}

let charts = {};

function abbrev(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (Math.round(n / 100) / 10) + 'k';
  return (Math.round(n / 100_000) / 10) + 'M';
}

async function refresh() {
  const range = document.getElementById('range').value;
  let data;
  try {
    const res = await fetch(`/api/stats?range=${range}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('fetch failed', err);
    return;
  }

  // Today's totals
  const t = data.todaysTotals ?? {};
  document.getElementById('totals').innerHTML = `
    <div><span class="label">Requests</span><span class="value">${abbrev(t.requests)}</span></div>
    <div><span class="label">Input</span><span class="value">${abbrev(t.input_tokens)}</span></div>
    <div><span class="label">Output</span><span class="value">${abbrev(t.output_tokens)}</span></div>
  `;

  // Tokens per day
  const dayMap = {};
  for (const r of data.tokensByDay) {
    (dayMap[r.date] ??= {})[r.model] = r.tokens;
  }
  const days = Object.keys(dayMap).sort();
  const models = [...new Set(data.tokensByDay.map((r) => r.model))].sort();
  renderStackedBar('chart-tokens', days, days.map((d) => models.map((m) => dayMap[d]?.[m] ?? 0)), models.map(modelHex));

  // Requests by hour-of-day
  renderBars('chart-hours', data.requestsByHourOfDay.map((r) => String(r.hour)), data.requestsByHourOfDay.map((r) => r.requests));

  // Cache hit rate
  renderBars('chart-cache', data.cacheHitRateByModel.map((r) => r.model), data.cacheHitRateByModel.map((r) => Math.round(r.hitRate * 100)), modelColor);

  // Top models
  const mtbody = document.querySelector('#table-models tbody');
  mtbody.innerHTML = data.topModels.map((r) => `
    <tr>
      <td><span class="session-swatch" style="background:${modelHex(r.model)}"></span>${r.model}</td>
      <td>${abbrev(r.requests)}</td>
      <td>${abbrev(r.input_tokens)}</td>
      <td>${abbrev(r.output_tokens)}</td>
      <td>${r.errors}</td>
    </tr>
  `).join('');

  // Top sessions
  const stbody = document.querySelector('#table-sessions tbody');
  stbody.innerHTML = data.topSessions.map((r) => `
    <tr>
      <td><span class="session-swatch" style="background:${modelHex(r.session_id)}"></span>${r.session_id?.slice(0, 8) ?? '—'}</td>
      <td>${r.requests}</td>
      <td>${abbrev(r.tokens)}</td>
    </tr>
  `).join('');

  // Errors
  const etbody = document.querySelector('#table-errors tbody');
  etbody.innerHTML = (data.errorsByStatus ?? []).map((r) => `<tr><td>${r.status}</td><td>${r.count}</td></tr>`).join('') || '<tr><td colspan="2">none</td></tr>';
}

function renderBars(canvasId, labels, values) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: '#4a86e8' }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}

function renderStackedBar(canvasId, labels, datasets, colors) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (charts[canvasId]) charts[canvasId].destroy();
  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: datasets[0].map((_, i) => ({
        label: labels[i] ? '' : '',
        data: datasets.map((d) => d[i]),
        backgroundColor: colors[i],
        stack: 'tokens',
      })),
    },
    options: { plugins: { legend: { display: true } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } }
  });
}

document.getElementById('range').addEventListener('change', refresh);
refresh();
setInterval(refresh, 10_000);
```

- [ ] **Step 5: Commit**

```bash
git add stats/public/
git commit -m "feat(stats): add dashboard (HTML, app.js, style.css, vendored chart.js)"
```

---

## Task 8: Create the orchestrator (`scripts/server.mjs`)

**Files:**
- Create: `scripts/server.mjs`

- [ ] **Step 1: Write `scripts/server.mjs`**

Create `scripts/server.mjs`:

```js
#!/usr/bin/env node
// Orchestrator for the usage-stats system.
// Spawns the batcher and HTTP server as child processes; respawns on crash;
// forwards SIGTERM to all children and waits for them to exit.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const STATS_DIR = join(here, '..', 'stats');
const SCRIPTS = [
  join(STATS_DIR, 'workers', 'batcher.mjs'),
  join(STATS_DIR, 'workers', 'server.mjs'),
];

const procs = new Map();
let shuttingDown = false;

function start(script) {
  const child = spawn('node', [script], { stdio: 'inherit' });
  procs.set(script, child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;        // expected during graceful stop
    console.error(`[stats] ${script} exited (code=${code} signal=${signal}); respawning in 1s`);
    setTimeout(() => start(script), 1000);
  });
}

for (const s of SCRIPTS) start(s);

process.on('SIGTERM', async () => {
  shuttingDown = true;
  await Promise.all([...procs.values()].map((c) => new Promise((resolve) => {
    c.once('exit', resolve);
    c.kill('SIGTERM');
  })));
  process.exit(0);
});

process.on('SIGINT', async () => {
  shuttingDown = true;
  await Promise.all([...procs.values()].map((c) => new Promise((resolve) => {
    c.once('exit', resolve);
    c.kill('SIGINT');
  })));
  process.exit(0);
});
```

- [ ] **Step 2: Verify the script is runnable**

Run: `node scripts/server.mjs &` then `kill %1` after a moment
Expected: process starts, prints nothing on stdout, and exits cleanly on SIGTERM

- [ ] **Step 3: Commit**

```bash
git add scripts/server.mjs
git commit -m "feat(stats): add orchestrator that supervises batcher + server children"
```

---

## Task 9: Create the stats plist and the install script

**Files:**
- Create: `scripts/com.claude-mixed-models.stats.plist`
- Modify: `scripts/install-router-service.sh` (rename to `scripts/install-services.sh` and extend)

- [ ] **Step 1: Read the existing router plist for the convention**

```bash
cat scripts/com.claude-mixed-models.router.plist
```

Use that as the template for the new plist.

- [ ] **Step 2: Write `scripts/com.claude-mixed-models.stats.plist`**

Create `scripts/com.claude-mixed-models.stats.plist` using the same shape as the router plist, but pointing at `scripts/server.mjs` and writing logs to `stats/server.log` / `stats/server.err.log`.

The exact key/value structure mirrors the router plist; replace:
- `Label`: `com.claude-mixed-models.stats`
- `ProgramArguments`: `["/usr/local/bin/node", "/Users/chris/dev/personal/claude-mixed-models/scripts/server.mjs"]` (use the user's actual home path)
- `StandardOutPath` / `StandardErrorPath`: paths under the project, e.g. `stats/server.log` and `stats/server.err.log`
- `WorkingDirectory`: the project root

- [ ] **Step 3: Rename and extend `install-router-service.sh` → `install-services.sh`**

```bash
git mv scripts/install-router-service.sh scripts/install-services.sh
```

Read the existing install script first, then extend it to install both plists. The key part: take the existing `launchctl load` / `launchctl unload` block and add a second block for the stats plist, parameterized over the label and plist path.

- [ ] **Step 4: Update `package.json`**

In `package.json`:
- Rename `"install-service"` to `"install-services"` and point at the renamed script.
- Add `"stats": "node bin/stats-cli.mjs"` (the CLI script comes in Task 10).
- Add `"engines": { "node": ">=22.5" }` to document the `node:sqlite` requirement.

- [ ] **Step 5: Update `.env.example`**

Append to `.env.example`:

```bash
# Usage-stats service. The stats server is a separate plist.
STATS_PORT=8789
STATS_EVENTS_FILE=/tmp/claude-mixed-models/router.events.jsonl
STATS_DB_PATH=$HOME/.local/state/claude-mixed-models/router.stats.db
```

- [ ] **Step 6: Verify the plist loads**

```bash
launchctl unload ~/Library/LaunchAgents/com.claude-mixed-models.stats.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.claude-mixed-models.stats.plist
launchctl start  com.claude-mixed-models.stats
sleep 1
curl -sf http://127.0.0.1:8789/api/stats?range=7d | head -c 200
```

Expected: a JSON payload (possibly empty) is returned.

- [ ] **Step 7: Commit**

```bash
git add scripts/com.claude-mixed-models.stats.plist scripts/install-services.sh package.json .env.example
git commit -m "feat(stats): add stats plist, install-services.sh, package.json scripts"
```

---

## Task 10: Create the CLI (`bin/stats-cli.mjs`)

**Files:**
- Create: `bin/stats-cli.mjs`

- [ ] **Step 1: Write the CLI**

Create `bin/stats-cli.mjs`:

```js
#!/usr/bin/env node
// Usage-stats CLI. One-shot by default; --watch re-renders every 5s.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tokensByDay,
  requestsByHourOfDay,
  cacheHitRateByModel,
  topModels,
  topSessions,
  errorsByStatus,
  todaysTotals,
} from '../stats/queries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

const DB_PATH = process.env.STATS_DB_PATH ?? `${process.env.HOME}/.local/state/claude-mixed-models/router.stats.db`;
const WATCH = process.argv.includes('--watch');
const RANGE = (process.argv.find((a) => a.startsWith('--range='))?.slice('--range='.length)) ?? '7d';

const RESET = '\x1b[0m';
const FG = {
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  red:   '\x1b[31m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  blue:  '\x1b[34m',
  cyan:  '\x1b[36m',
};

function abbrev(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (Math.round(n / 100) / 10) + 'k';
  return (Math.round(n / 100_000) / 10) + 'M';
}

function color(s, code) { return `${code}${s}${RESET}`; }

function renderCards(db) {
  const totals  = todaysTotals(db);
  const models  = topModels(db, RANGE, 5);
  const sessions = topSessions(db, RANGE, 5);
  const errors  = errorsByStatus(db, '24h');
  const hours   = requestsByHourOfDay(db, RANGE);

  const out = [];
  out.push(color(`Usage stats · range=${RANGE}`, FG.bold));
  out.push('');
  out.push(`${color('Today', FG.dim)}                  ${color(abbrev(totals.requests), FG.cyan)} requests · ${color(abbrev(totals.input_tokens), FG.blue)} in · ${color(abbrev(totals.output_tokens), FG.cyan)} out`);
  out.push('');
  out.push(color('Top models', FG.bold));
  for (const m of models) {
    const errRate = m.requests > 0 ? (m.errors / m.requests * 100).toFixed(1) : '0.0';
    const errColor = m.errors > 0 ? FG.red : FG.dim;
    out.push(`  ${m.model.padEnd(28)} ${color(String(m.requests).padStart(6), FG.cyan)} reqs · ${color(abbrev(m.input_tokens).padStart(7), FG.blue)} in · ${color(abbrev(m.output_tokens).padStart(6), FG.cyan)} out · ${color(errRate.padStart(5) + '%', errColor)} err`);
  }
  out.push('');
  out.push(color('Top sessions', FG.bold));
  for (const s of sessions) {
    out.push(`  ${(s.session_id ?? '—').slice(0, 8).padEnd(10)} ${color(String(s.requests).padStart(5), FG.cyan)} reqs · ${color(abbrev(s.tokens).padStart(7), FG.blue)} tokens`);
  }
  out.push('');
  out.push(color('Requests by hour-of-day', FG.bold));
  const max = Math.max(...hours.map((h) => h.requests), 1);
  for (const h of hours) {
    const bar = '█'.repeat(Math.round((h.requests / max) * 20)).padEnd(20, ' ');
    out.push(`  ${String(h.hour).padStart(2, '0')}:00  ${color(bar, FG.cyan)} ${h.requests}`);
  }
  out.push('');
  out.push(color('Errors (last 24h)', FG.bold));
  if (errors.length === 0) out.push(color('  none', FG.green));
  for (const e of errors) out.push(`  ${color(e.status, FG.red)}: ${e.count}`);
  return out.join('\n');
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.log('no data yet');
    return;
  }
  if (WATCH) {
    const render = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      try {
        const db = new DatabaseSync(DB_PATH, { readOnly: true });
        console.log(renderCards(db));
        db.close();
      } catch (err) {
        console.error('error:', err.message);
      }
    };
    render();
    setInterval(render, 5_000);
  } else {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    console.log(renderCards(db));
    db.close();
  }
}

main();
```

- [ ] **Step 2: Smoke-test the CLI**

Run: `node bin/stats-cli.mjs --range=7d`
Expected: card text printed in color (or no-data message if no events yet)

Run: `node bin/stats-cli.mjs --watch`
Expected: full-screen repaint every 5s; Ctrl-C to exit

- [ ] **Step 3: Commit**

```bash
git add bin/stats-cli.mjs
git commit -m "feat(stats): add bin/stats-cli.mjs with one-shot + --watch modes"
```

---

## Task 11: Documentation + final integration test

**Files:**
- Create: `docs/operations/stats-services.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write `docs/operations/stats-services.md`**

Create `docs/operations/stats-services.md`:

```markdown
# Usage-stats service

The stats service is a separate plist (`com.claude-mixed-models.stats`) that runs
`scripts/server.mjs`, which supervises two child processes: the batcher and the
HTTP server. Install alongside the router plist:

```bash
scripts/install-services.sh
```

The plist writes logs to `stats/server.log` and `stats/server.err.log`. Tail
either file to see what the orchestrator and its children are doing.

## Endpoints

- `GET /`             — dashboard
- `GET /api/stats?range=24h|7d|30d|all` — JSON for the cards

The server binds to `127.0.0.1` on `STATS_PORT` (default 8789). There is no auth —
the assumption is "only the laptop's user can reach localhost".

## State files

- `STATS_EVENTS_FILE` (default `/tmp/claude-mixed-models/router.events.jsonl`):
  transient write buffer; truncated by the batcher after each pass. Safe to delete
  while the router is running — the next batcher pass will just find nothing.
- `STATS_DB_PATH` (default `~/.local/state/claude-mixed-models/router.stats.db`):
  persistent SQLite database. Don't delete this — it's the source of truth.

## Restarting

```bash
launchctl stop  com.claude-mixed-models.stats
launchctl start com.claude-mixed-models.stats
```

The router plist (`com.claude-mixed-models.router`) is independent and is not
affected by stats restart.
```

- [ ] **Step 2: Add a "Stats" section to `README.md`**

Find the `Running as a service` section in `README.md` and add a paragraph:

```markdown
## Usage stats
The router emits a JSONL event per request. A separate `com.claude-mixed-models.stats`
plist (`scripts/server.mjs`) batches those events into a SQLite database and serves
a self-hosted dashboard at `http://localhost:8789` plus a CLI via `npm run stats`.
See `docs/operations/stats-services.md` for install / restart / state-file details.
```

- [ ] **Step 3: Add a CHANGELOG entry**

In `CHANGELOG.md`, add a new section above the existing `## 2026-06-03`:

```markdown
## 2026-06-08

### Tasks
- add usage-stats service: JSONL event sink, SQLite rollups, self-hosted dashboard, terminal CLI (#observability, #stats)
- per-model token-cost rates in the dashboard's "today" card
- vendored chart.js for offline dashboard rendering
```

- [ ] **Step 4: Run the full test suite**

Run: `node --test 2>&1 | tail -30`
Expected: all tests pass — `lib/event.test.js`, `lib/log.test.js`, `lib/sse.test.js`, `router/server.test.js`, `stats/queries.test.js`, `stats/workers/batcher.test.js`, `stats/workers/server.test.js`

- [ ] **Step 5: End-to-end smoke test**

1. Start the router: `npm run router &`
2. Start the stats plist: `launchctl start com.claude-mixed-models.stats`
3. Send a few requests through the router (e.g. with `claude` pointed at it).
4. Open `http://localhost:8789` — verify the cards render.
5. Run `npm run stats` — verify the CLI prints the same data.
6. Kill the batcher child: `pkill -f stats/workers/batcher.mjs`. Wait 1s, then check `stats/server.log` for the respawn message. Verify the dashboard continues to receive fresh data.
7. Kill the whole plist: `launchctl stop com.claude-mixed-models.stats`. Verify the router is still routing traffic (router plist is independent).

- [ ] **Step 6: Commit**

```bash
git add docs/operations/stats-services.md README.md CHANGELOG.md
git commit -m "docs(stats): operations guide, README section, CHANGELOG entry"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implementing task |
|---|---|
| Goal | Tasks 1-11 collectively |
| Non-goals (no auth, best-effort, etc.) | Tasks 5, 6 (best-effort error handling), 8 (no auth) |
| Architecture diagram (router unchanged, stats plist + 2 children) | Tasks 8, 9 |
| `lib/event.js` sink | Task 1 |
| Hook into `finalize()` | Task 2 |
| `real_model` capture, drop `cwd` | Task 2 |
| `(id, ts)` composite PK | Task 3 |
| WAL pragmas | Task 3 |
| 5m/1h/1d rollup tables | Task 3 |
| Query routing per card | Task 4 |
| Recompute-not-increment batcher | Task 5 |
| Read-only HTTP server | Task 6 |
| WAL read-only visibility test | Task 6 |
| Dashboard + chart.js vendored | Task 7 |
| Orchestrator with respawn + signal forward | Task 8 |
| Plist + install-services.sh | Task 9 |
| One-shot + --watch CLI | Task 10 |
| Testing strategy (unit, integration, property, smoke) | Tasks 4, 5, 6, 11 |
| Best-effort error handling (no retry queues, no health checks) | Tasks 5, 6, 10 |

**2. Placeholder scan:** No TBDs. Every code step has a complete code block. No "similar to Task N" cross-references.

**3. Type consistency:**
- `runOnce({ jsonlPath, dbPath, schemaPath })` in Task 5 → called with the same shape in Task 5's test. ✓
- `startServer({ dbPath, port, publicDir, host })` in Task 6 → called with the same shape in Task 6's test. ✓
- `startServer` returns `{ url, close, server }` → tests use `url` and `close`. ✓
- `queries.js` exports (`tokensByDay`, etc.) → used by both the server (Task 6) and CLI (Task 10) with the same call signature. ✓
- The `__abbrev` helper exists in `lib/log.js`; the dashboard's `app.js` and the CLI's `abbrev` are *separate* copies (intentional — `app.js` is browser code, the CLI is Node, and `lib/log.js`'s `__abbrev` is a private export). I considered sharing but the duplication is ~6 lines and the cross-boundary cost (browser bundling, node-only imports) isn't worth it. Acceptable.

**4. Issues found during review:**
- Task 4's `todaysTotals(db, range)` is called from the server, but the test calls it with no range. The implementation is `todaysTotals(db)` with no range — consistent. The server originally had `query(dbPath, null, todaysTotals)` which would pass `null` as range; the function ignores range, so this works. Cleaned up by passing `'all'` (the only no-threshold range) so the `query()` shape is uniform across all card handlers.
- Task 5's `bucketStart('2026-06-08T10:00:00.000Z', '5m')` returns `2026-06-08T10:00:00.000Z` (top of 5-min window). The implementation floors to 5-minute boundaries — for `10:00` it returns `10:00`; for `10:03` it returns `10:00`; for `10:05` it returns `10:05`. Correct.

Fixed inline:

- Task 6, `query(dbPath, null, todaysTotals)` → `query(dbPath, 'all', todaysTotals)`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-08-usage-stats.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
