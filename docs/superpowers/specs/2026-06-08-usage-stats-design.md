# Usage stats service

**Date:** 2026-06-08
**Status:** approved

## Goal

Surface aggregated model usage, time-of-day, token, cache, and session statistics from the router's existing log stream, via a self-hosted HTML dashboard and a terminal CLI. Statistics are approximate and best-effort; the system is for spotting patterns, not balancing a ledger.

The router already captures everything we need on every request — `model`, `upstream`, `status`, `durationMs`, `sessionId`, and the four token counts (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) — into `router.log`. This work adds a parallel write buffer, a SQLite index, a dashboard, and a CLI.

## Non-goals

- **100% data accuracy.** Best-effort is the spec. If a JSONL line is malformed, drop it. If a batcher pass loses events, accept it.
- **Log shipping / external observability.** No OTel, no Prometheus, no Loki. The dashboard is local and self-hosted.
- **Multi-user / multi-machine aggregation.** One laptop, one router, one stats service.
- **Auth on the dashboard.** It binds to localhost on `STATS_PORT` and that's the auth model.
- **Production-grade health checks.** The dashboard auto-refreshes; if data is stale, the next refresh fixes it. No "last updated" badge, no `/api/health`, no alerts.
- **PII capture.** The JSONL carries `sessionId` (a UUID), not the full `metadata.user_id` object. Request bodies and message contents are never captured.
- **Rollup analytics beyond what the dashboard needs.** No cohort analysis, no funnel analysis, no Anomaly detection. The seven cards in the dashboard are the whole product.

## Architecture

Two long-running services, **one orchestrator that lives in `scripts/`**:

```
Claude Code ──HTTP──▶ router (plist, unchanged) ──HTTP──▶ MiniMax / Anthropic
                          │
                          │ logEvent() appends JSON line
                          ▼
                     router.events.jsonl    ◀── transient buffer
                          │
                          │ fs.watch + 10s safety timer
                          ▼
              ┌─────── scripts/server.mjs (one plist) ───────┐
              │                                                │
              │   ┌─ batcher child ──┐   ┌─ http child ─┐       │
              │   │ reads JSONL      │   │ serves / and │       │
              │   │ writes SQLite    │   │ /api/stats   │       │
              │   │ unlinks JSONL    │   │ queries db   │       │
              │   └──────────────────┘   └──────────────┘       │
              │           │                     │               │
              └───────────┴─────────────────────┘               │
                          │                                     │
                          ▼                                     │
                     router.stats.db          ◀── source of truth
```

`scripts/server.mjs` is the single entry point for everything stats-related. It spawns the batcher and HTTP server as child processes, supervises them, and forwards signals. The router plist is left untouched.

The router is unchanged in topology; one new `logEvent()` call inside `forward()`. The stats service is a single plist (`com.claude-mixed-models.stats`) that runs `scripts/server.mjs`, which spawns two child processes — batcher and HTTP server — and supervises them (respawn on exit, forward SIGTERM). The CLI (`bin/stats-cli.mjs`) and tests import the worker modules directly, so they don't need the orchestrator.

### Why child processes, not worker threads

- The two children are independent: a wedged HTTP request handler can't stall the batcher. Separate event loops, separate GC.
- No shared state to manage — they communicate only through the SQLite file, which WAL mode makes concurrent-safe.
- If the dashboard ever needs to move to a different machine, the child boundary is already there.

### Why a single orchestrator

- One `KeepAlive` target, one log file, one service to `launchctl start|stop`.
- The orchestrator is ~30 lines: spawn, respawn, signal-forward. No IPC, no state.
- The router plist stays untouched and orthogonal — its lifecycle is independent of stats.

## Event sink

`lib/event.js` (new, separate from `lib/log.js` to keep concerns split):

```js
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const EVENTS_FILE = process.env.STATS_EVENTS_FILE ?? '/tmp/claude-mixed-models/router.events.jsonl';
try { mkdirSync(dirname(EVENTS_FILE), { recursive: true }); } catch { /* best-effort */ }

// Best-effort: a failed append must never throw on the router's response path.
export function logEvent(fields) {
  try {
    appendFileSync(EVENTS_FILE, JSON.stringify({ ...fields, ts: new Date().toISOString() }) + '\n');
  } catch (err) {
    console.error('[stats] logEvent failed (dropping event):', err.message);
  }
}
```

Called from `router/server.js` inside **`finalize()`** (the single terminal path shared by all four request exits: normal end, empty-200→502, client-close 499, and upstream-error 502). `finalize` already dedupes via its `done` flag, so each request emits exactly one event. Hooking here — rather than "after `extractUsageFromSse` resolves", which only runs on the normal-end path — is what guarantees the 499/502 statuses in the record table below actually get logged. `finalize`'s existing fields (`upstream`, `status`, `durationMs`, `usage`, `session`) plus `id`, `model` (the alias, captured in `handleRequest` *before* `body.model` is reassigned to `route.realModel`), and `real_model` (all threaded into `forward()`'s opts) feed `logEvent`; on the 499/502/empty paths `usage` is `null`, so token fields default to 0. The directory is created once at module load and the append is wrapped in try/catch, so the sink can never throw on the hot path. No new dependencies beyond a single guarded `appendFileSync`.

**Event record** (~150 bytes per line):

| Field | Type | Source |
|---|---|---|
| `ts` | ISO 8601 string | `new Date().toISOString()` at log time |
| `id` | 8-char hex | existing `newRequestId()` from `lib/log.js` |
| `model` | string | the client-requested **alias**, captured *before* the route rewrite (e.g. `minimax`, `minimax-m2.7`, `claude-opus-4-8`) |
| `real_model` | string | the resolved upstream model after `route.realModel` rewrite (e.g. `MiniMax-M3`); equals `model` for passthrough/unmapped traffic |
| `upstream` | hostname | `conn.url.host` |
| `status` | integer | upstream HTTP status (or 499 on client cancel, 502 on empty body) |
| `durationMs` | integer | `Date.now() - t0` |
| `sessionId` | UUID string \| null | existing `sessionIdFromUserId()` extraction |
| `input_tokens` | integer | from `usage.input_tokens` (0 if absent) |
| `output_tokens` | integer | from `usage.output_tokens` |
| `cache_read_input_tokens` | integer | from `usage.cache_read_input_tokens` |
| `cache_creation_input_tokens` | integer | from `usage.cache_creation_input_tokens` |

The `metadata.user_id` object is *not* captured — only the extracted `sessionId` UUID. Request bodies and message contents are *never* captured. (A `cwd` field was considered and dropped: the only value the router can read is `process.cwd()`, which is its own launchd working directory — a constant across every event, not the client's project directory — so it carries no signal.)

## Storage

### `router.events.jsonl` (transient write buffer)

- Owned by the router process (writable by router's user).
- Append-only while the batcher reads it.
- The batcher truncates the file to 0 bytes after each successful insert pass.
- Worst case on crash (truncate never ran): the whole file is re-read on the next pass. That's safe — `INSERT OR IGNORE` plus recompute-from-`events` make a re-read idempotent, so re-processing already-inserted lines changes nothing.

### `router.stats.db` (SQLite, source of truth)

Persistent — it lives at `STATS_DB_PATH` (default `~/.local/state/claude-mixed-models/router.stats.db`), **not** under `/tmp`, so a reboot or `/tmp` sweep can't wipe the source of truth. Only the transient `router.events.jsonl` write buffer lives in `/tmp`. The batcher is the only writer, and on startup it `mkdirSync(dirname(STATS_DB_PATH), { recursive: true })` *before* opening the DB, so a fresh install never fails with a missing-directory error.

Built-in `node:sqlite` (`DatabaseSync` from `node:sqlite`, available in Node 22.5+ as experimental, stable in Node 24+; the project's `.nvmrc` / no-pin and the existing v26.0.0 runtime qualify). No native dependency. WAL mode enabled via `PRAGMA journal_mode=WAL` in the schema file so readers don't block writers.

#### Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;     -- safe with WAL; ~2x faster than FULL

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
  -- (id, ts) rather than id alone: retried JSONL lines still dedup (same id+ts),
  -- but a real 32-bit id collision must also share an exact ms timestamp to drop.
  PRIMARY KEY (id, ts)
);
CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_model    ON events(model);
CREATE INDEX IF NOT EXISTS idx_events_upstream ON events(upstream);
CREATE INDEX IF NOT EXISTS idx_events_session  ON events(session_id);

-- 5-minute rollup. Drives the live dashboard.
CREATE TABLE IF NOT EXISTS rollup_5m (
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
CREATE INDEX IF NOT EXISTS idx_5m_bucket ON rollup_5m(bucket_start);
```

`rollup_1h` and `rollup_1d` have the same shape, with `bucket_start` as `YYYY-MM-DDTHH:00:00Z` and `YYYY-MM-DD` respectively. All three are populated by the batcher after each insert pass. Same `PRIMARY KEY (bucket_start, model, upstream)` upsert pattern.

### Query routing

| Card | Range | Reads from |
|---|---|---|
| Tokens/day (last 30d) | 30d | `rollup_1d` |
| Requests by hour-of-day (7d) | 7d | `rollup_1h`, GROUP BY hour-of-day (0–23) |
| Cache hit rate (last 7d) | 7d | `rollup_1h` |
| Top models (last 7d) | 7d | `rollup_1h`, ORDER BY SUM(input) |
| Top sessions (last 7d) | 7d | `events` (sparse; rollups don't carry session_id) |
| Errors (last 24h) | 24h | `rollup_5m` |
| Today's totals | today | `rollup_5m`, SUM |

`events` is scanned only for the per-session card. Everything else is rollup-only. This keeps dashboard reads at O(rollup_rows) regardless of how long the router has been running.

### Percentiles

`p50_ms` and `p95_ms` are precomputed in the batcher, but **derived from `events`, not an in-memory reservoir**. Each pass recomputes every touched bucket's rollup row (see §Batcher) by aggregating that bucket's `events.duration_ms` directly, so percentiles need no cross-pass state and a batcher respawn loses nothing. Each (bucket, model, upstream) holds at most a few hundred rows for a 5-minute window — sorting them to pick p50/p95 in JS is trivial, and only buckets touched by the current pass are recomputed.

## Batcher worker (`stats/workers/batcher.mjs`)

```
open router.events.jsonl in 'a+' mode (keeps an fd, fs.watch is reliable)
open SQLite, exec schema.sql (idempotent), set prepared insert
loop:
  await wait for fs.watch 'change' OR 10s safety timer
  read all lines from JSONL
  touched = {}  // set of (bucket_start, model, upstream) across all three grains
  for each line:
    try parse + INSERT OR IGNORE; on error, log + skip
    record the 5m/1h/1d buckets this event falls into in `touched`
  for each (grain, bucket_start, model, upstream) in touched:
    recompute the rollup row from events:
      SELECT count, errors, SUM(tokens...), p50/p95 FROM events
        WHERE ts in [bucket_start, bucket_end) AND model=? AND upstream=?
    UPSERT the full row (INSERT ... ON CONFLICT DO UPDATE SET <recomputed values>)
  COMMIT
  truncate JSONL to 0 bytes
```

Rollups are **recomputed from `events`, never incremented.** This is what makes a pass idempotent: events use `INSERT OR IGNORE` (deduped by the `(id, ts)` primary key), so a retried pass — e.g. after a DB error left the JSONL untruncated — re-derives the same rollup values instead of double-counting. Recomputing only the touched buckets keeps each pass O(rows-in-this-batch), and it preserves the property-test invariant `SUM(rollup_1d.requests) == COUNT(events)` per day by construction.

Best-effort throughout. A bad JSONL line is skipped. A DB error is logged and the JSONL is *not* truncated (next pass retries; recompute makes the retry safe). No retry queue, no quarantine file, no max-line-bytes watchdog.

## HTTP worker (`stats/workers/server.mjs`)

- Listens on `STATS_PORT` (default 8789).
- `GET /` → `stats/public/index.html` (single self-contained file, no build step, no framework).
- `GET /api/stats?range=24h|7d|30d|all` → JSON for the cards.
- Opens the SQLite DB read-only (`new DatabaseSync(path, { readOnly: true })`). With WAL, a read-only connection still needs the `-shm`/`-wal` sidecars accessible to see the batcher's latest commits — they live alongside the DB under `STATS_DB_PATH`, so the reader and batcher sharing that directory is required. A read-only reader cannot run WAL recovery, so it must never be the only connection that touches a freshly created DB; in practice the batcher creates and checkpoints the DB first.
- Each `/api/stats` request runs the card queries; results are JSON-serialized with the existing `__abbrev` helper so the dashboard sees compact numbers.
- The HTTP server reuses the same `http` module pattern as `router/server.js`, including the `installShutdown`-style graceful shutdown.

## Orchestrator (`scripts/server.mjs`)

```js
import { spawn } from 'node:child_process';

const SCRIPTS = ['stats/workers/batcher.mjs', 'stats/workers/server.mjs'];
const procs = new Map();            // script -> ChildProcess
let shuttingDown = false;

function start(script) {
  const child = spawn('node', [script], { stdio: 'inherit' });
  procs.set(script, child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;        // expected during graceful stop
    console.error(`[stats] ${script} exited (code=${code} signal=${signal}); respawning in 1s`);
    setTimeout(() => start(script), 1000);   // re-registers its own exit handler
  });
}
for (const s of SCRIPTS) start(s);

process.on('SIGTERM', async () => {
  shuttingDown = true;
  await Promise.all([...procs.values()].map((c) => new Promise((resolve) => {
    c.once('exit', resolve);
    c.kill('SIGTERM');               // let each child run its own graceful shutdown
  })));
  process.exit(0);
});
```

Keying live children by script name (rather than holding a stale array reference) means a respawned child re-registers its own `exit` handler and SIGTERM always targets the *current* child. The `shuttingDown` flag distinguishes an intentional stop from a crash so we don't respawn during shutdown, and the parent waits for every child to actually exit before exiting itself. No exponential backoff — a fixed 1s respawn is deliberate (a throttled respawn is harder to reason about than one visibly-flapping child).

`scripts/server.mjs` lives in the existing `scripts/` directory alongside the other operational scripts (the install script, the plist, the run scripts). It's the single entry point for everything stats-related. No IPC, no shared state. Each child is a self-contained module. The orchestrator is ~30 lines.

## CLI (`bin/stats-cli.mjs`)

One binary, two modes:

- `npm run stats` → one-shot. Prints the same seven cards as text with the existing ANSI color palette. Color is always emitted (matches `lib/log.js` convention).
- `npm run stats -- --watch` → re-renders every 5s, full-screen repaint (clear via `process.stdout.write('\x1b[2J\x1b[H')`).

Both modes open the SQLite DB read-only. If the DB is missing, print "no data yet" and exit 0.

## Dashboard (`stats/public/`)

Vanilla HTML/CSS/JS, no build step, no framework. `chart.js` is **vendored** into `stats/public/chart.min.js` (pinned version, referenced with a relative `<script src>`) so the localhost dashboard renders offline and the dependency can't drift. Auto-refresh every 10s (same cadence as the batcher, so the dashboard is always within one batch of live).

### Cards

| Card | What it shows |
|---|---|
| Tokens/day | stacked bar chart, 30 days, by model |
| Requests by hour-of-day | bar chart, 24 buckets (hours 0–23) aggregated over the last 7d — surfaces the recurring time-of-day pattern |
| Cache hit rate | per-model bar chart, "uncached-token spend" signal |
| Top models | table: model, requests, in/out tokens, error %, p50/p95 latency |
| Top sessions | table: session_id (truncated, color-swatched), requests, total tokens, duration span |
| Errors | last 24h, count by status code |
| Today's totals | one-line summary: N requests, X tokens, $est cost |

**Cost estimate:** a small per-model rate map keyed by the alias `model` (which maps 1:1 to a real model, so the rate is unambiguous and the rollups — which carry the alias, not `real_model` — can be priced directly). Four rates each (input, output, cache-read, cache-write per M tokens) so MiniMax and Anthropic — which differ ~10x, and whose cache reads are ~10x cheaper than fresh input — aren't blended into one misleading number. An unknown alias falls back to a flagged default rate, and the cost card renders the rate label in dim text plus a "?" suffix on the figure (e.g. `$0.42?`) so the estimate's lower confidence is visible at a glance. Still labeled an estimate; the map is a code constant in v1 (full configurability is future work).

### Color reuse

The djb2-of-first-8-chars hash from `__colorEscapeForModel` in `lib/log.js` is replicated in the dashboard's `app.js` so the same model renders the same color in `tail -f router.log` and in the dashboard. The 12-color palette is exposed as CSS custom properties.

## Service definitions

| Service | Binary | Port | Log files |
|---|---|---|---|
| `com.claude-mixed-models.router` (unchanged) | `router/server.js` | 8788 | `router.log`, `router.err.log` |
| `com.claude-mixed-models.stats` (new) | `scripts/server.mjs` | 8789 (via child) | `stats/server.log`, `stats/server.err.log` |

`scripts/install-services.sh` (renamed from `install-router-service.sh`) installs both. `package.json`'s `install-service` script is renamed to `install-services`.

**State directories:** the persistent DB lives at `STATS_DB_PATH` (default `~/.local/state/claude-mixed-models/router.stats.db`); the transient JSONL buffer lives at `STATS_EVENTS_FILE` (default `/tmp/claude-mixed-models/router.events.jsonl`). `STATS_PORT` defaults to 8789. All three go in `.env.example`.

## File layout

```
stats/
  workers/
    batcher.mjs
    server.mjs
  queries.mjs
  schema.sql
  public/
    index.html
    app.js
    style.css
    chart.min.js            (vendored, pinned)
  workers/batcher.test.js
  workers/server.test.js
  queries.test.js
bin/
  stats-cli.mjs
lib/
  event.js
  event.test.js
scripts/
  server.mjs                (the orchestrator)
  install-services.sh
  com.claude-mixed-models.stats.plist
  com.claude-mixed-models.router.plist  (unchanged)
docs/
  operations/
    stats-services.md
docs/superpowers/
  specs/
    2026-06-08-usage-stats-design.md     (this file)
  plans/
    2026-06-08-usage-stats.md            (the implementation plan, written next)
CHANGELOG.md
package.json
README.md
```

## Testing strategy

`node:test` only, matching the existing convention.

**Unit tests:**
- `lib/event.test.js` — `logEvent()` writes valid JSON, handles missing fields, escapes newlines.
- `stats/queries.test.js` — build an in-memory `DatabaseSync`, insert known rows, assert each card query returns expected shape and sums.
- `stats/workers/batcher.test.js` — write 5 lines to a temp JSONL, run one batcher pass, assert `events` has 5 rows and the JSONL is truncated. Write 3 more with one duplicate id, assert only 2 new rows.
- `stats/workers/server.test.js` — start the HTTP server on an ephemeral port, `fetch('/api/stats?range=24h')`, assert JSON shape. Tear down.
- **Read-only WAL visibility** — open a writer (batcher-style) and a separate `readOnly: true` reader against the same WAL DB; commit a row from the writer *after* the reader opened, then assert the reader observes it. Guards against the read-only-WAL stale-read footgun.

**Property test (one):** for a random sequence of events, after the batcher runs, `SUM(rollup_1d.requests)` for a given day equals `COUNT(*)` of raw events for that day. Cheap, catches off-by-one bugs.

**Manual smoke test:** the existing convention (no CI). `npm run stats` against a populated DB, eyeball the cards. Open the dashboard, click around, watch it auto-refresh. Kill the batcher child, send traffic, watch the dashboard recover when the orchestrator respawns it.

## Error handling

Best-effort throughout. No retry queues, no quarantine files, no health-check endpoints.

- **Batcher:** bad JSONL line → log + skip. DB error → log + leave JSONL alone (next pass retries).
- **HTTP server:** DB missing → empty JSON payload, dashboard shows "no data yet". DB busy → `node:sqlite` throws after its default timeout; server returns 500, dashboard shows the error in a corner.
- **CLI:** DB missing → print "no data yet", exit 0.
- **Orchestrator:** child exits → wait 1s, respawn. No exponential backoff (one zombie child is easier to debug than a throttled respawn).
- **Time zones:** `ts` stored UTC. "Today" is computed in the user's local timezone (matches `/status`).
- **Disk usage:** not monitored. At ~150 bytes/event and ~10k req/day, the `events` table grows ~1.5 MB/day. SQLite handles this fine; we don't `VACUUM` on any schedule.

## Future work (not in v1)

- Health endpoint
- Configurable cost-per-token model
- Per-session latency percentiles
- Drill-down views from the dashboard
- Log shipping / external observability integration
