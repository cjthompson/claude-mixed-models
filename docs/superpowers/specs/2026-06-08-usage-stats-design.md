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
import { appendFileSync } from 'node:fs';
export function logEvent(fields) {
  appendFileSync(process.env.STATS_EVENTS_FILE ?? '/tmp/claude-mixed-models/router.events.jsonl',
    JSON.stringify({ ...fields, ts: new Date().toISOString() }) + '\n');
}
```

Called from `router/server.js` inside `forward()`, immediately after `extractUsageFromSse` resolves. No new dependencies on the hot path beyond a single `appendFileSync`.

**Event record** (~150 bytes per line):

| Field | Type | Source |
|---|---|---|
| `ts` | ISO 8601 string | `new Date().toISOString()` at log time |
| `id` | 8-char hex | existing `newRequestId()` from `lib/log.js` |
| `model` | string | request body's `model` field (e.g. `minimax`, `claude-haiku-4-5-20251001`) |
| `upstream` | hostname | `conn.url.host` |
| `status` | integer | upstream HTTP status (or 499 on client cancel, 502 on empty body) |
| `durationMs` | integer | `Date.now() - t0` |
| `sessionId` | UUID string \| null | existing `sessionIdFromUserId()` extraction |
| `cwd` | string | captured once at router startup |
| `input_tokens` | integer | from `usage.input_tokens` (0 if absent) |
| `output_tokens` | integer | from `usage.output_tokens` |
| `cache_read_input_tokens` | integer | from `usage.cache_read_input_tokens` |
| `cache_creation_input_tokens` | integer | from `usage.cache_creation_input_tokens` |

`cwd` is captured in `handleRequest` from `process.cwd()` and threaded through to `forward()`. The `metadata.user_id` object is *not* captured — only the extracted `sessionId` UUID. Request bodies and message contents are *never* captured.

## Storage

### `router.events.jsonl` (transient write buffer)

- Owned by the router process (writable by router's user).
- Append-only while the batcher reads it.
- The batcher truncates the file to 0 bytes after each successful insert pass.
- Worst case on crash: the next batcher run picks up where it left off.

### `router.stats.db` (SQLite, source of truth)

Built-in `node:sqlite` (`DatabaseSync` from `node:sqlite`, available in Node 22.5+ as experimental, stable in Node 24+; the project's `.nvmrc` / no-pin and the existing v26.0.0 runtime qualify). No native dependency. WAL mode enabled via `PRAGMA journal_mode=WAL` in the schema file so readers don't block writers.

#### Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;     -- safe with WAL; ~2x faster than FULL

CREATE TABLE IF NOT EXISTS events (
  id                          TEXT PRIMARY KEY,
  ts                          TEXT NOT NULL,
  model                       TEXT NOT NULL,
  upstream                    TEXT NOT NULL,
  status                      INTEGER NOT NULL,
  duration_ms                 INTEGER NOT NULL,
  session_id                  TEXT,
  cwd                         TEXT,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0
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
| Tokens/day (last 7d) | 7d | `rollup_1h`, GROUP BY date |
| Requests/hour (last 24h) | 24h | `rollup_5m`, GROUP BY hour |
| Cache hit rate (last 7d) | 7d | `rollup_1h` |
| Top models (last 7d) | 7d | `rollup_1h`, ORDER BY SUM(input) |
| Top sessions (last 7d) | 7d | `events` (sparse; rollups don't carry session_id) |
| Errors (last 24h) | 24h | `rollup_5m` |
| Today's totals | today | `rollup_5m`, SUM |

`events` is scanned only for the per-session card. Everything else is rollup-only. This keeps dashboard reads at O(rollup_rows) regardless of how long the router has been running.

### Percentiles

`p50_ms` and `p95_ms` are precomputed in the batcher. For each (bucket, model, upstream), the batcher keeps a small in-memory reservoir of durations for the current 5-minute window and computes percentiles on bucket rollover. ~144 buckets/day/model is cheap to recompute.

## Batcher worker (`stats/workers/batcher.mjs`)

```
open router.events.jsonl in 'a+' mode (keeps an fd, fs.watch is reliable)
open SQLite, exec schema.sql (idempotent), set prepared insert
loop:
  await wait for fs.watch 'change' OR 10s safety timer
  read all lines from JSONL
  for each line:
    try parse + insert; on error, log + skip
  for each (bucket, model, upstream) touched:
    UPDATE rollup_5m SET requests += ..., errors += ...
  COMMIT
  truncate JSONL to 0 bytes
```

Best-effort throughout. A bad JSONL line is skipped. A DB error is logged and the JSONL is *not* truncated (next pass retries). No retry queue, no quarantine file, no max-line-bytes watchdog.

## HTTP worker (`stats/workers/server.mjs`)

- Listens on `STATS_PORT` (default 8789).
- `GET /` → `stats/public/index.html` (single self-contained file, no build step, no framework).
- `GET /api/stats?range=24h|7d|30d|all` → JSON for the cards.
- Opens the SQLite DB read-only (`new DatabaseSync(path, { readOnly: true })`).
- Each `/api/stats` request runs the card queries; results are JSON-serialized with the existing `__abbrev` helper so the dashboard sees compact numbers.
- The HTTP server reuses the same `http` module pattern as `router/server.js`, including the `installShutdown`-style graceful shutdown.

## Orchestrator (`scripts/server.mjs`)

```js
import { spawn } from 'node:child_process';
const children = [
  spawn('node', ['stats/workers/batcher.mjs'], { stdio: 'inherit' }),
  spawn('node', ['stats/workers/server.mjs'],  { stdio: 'inherit' }),
];
for (const child of children) {
  child.on('exit', (code) => {
    console.error(`[stats] ${child.spawnargs.join(' ')} exited with code ${code}, respawning in 1s`);
    setTimeout(() => respawn(child), 1000);
  });
}
process.on('SIGTERM', () => { for (const c of children) c.kill('SIGTERM'); process.exit(0); });
```

`scripts/server.mjs` lives in the existing `scripts/` directory alongside the other operational scripts (the install script, the plist, the run scripts). It's the single entry point for everything stats-related. No IPC, no shared state. Each child is a self-contained module. The orchestrator is ~30 lines.

## CLI (`bin/stats-cli.mjs`)

One binary, two modes:

- `npm run stats` → one-shot. Prints the same seven cards as text with the existing ANSI color palette. Color is always emitted (matches `lib/log.js` convention).
- `npm run stats -- --watch` → re-renders every 5s, full-screen repaint (clear via `process.stdout.write('\x1b[2J\x1b[H')`).

Both modes open the SQLite DB read-only. If the DB is missing, print "no data yet" and exit 0.

## Dashboard (`stats/public/`)

Vanilla HTML/CSS/JS, no build step, no framework. `chart.js` loaded from CDN as a single `<script>` line. Auto-refresh every 10s (same cadence as the batcher, so the dashboard is always within one batch of live).

### Cards

| Card | What it shows |
|---|---|
| Tokens/day | stacked bar chart, 30 days, by model |
| Requests/hour | bar chart, 24 buckets, all-time — surfaces time-of-day pattern |
| Cache hit rate | per-model bar chart, "uncached-token spend" signal |
| Top models | table: model, requests, in/out tokens, error %, p50/p95 latency |
| Top sessions | table: session_id (truncated, color-swatched), requests, total tokens, duration span |
| Errors | last 24h, count by status code |
| Today's totals | one-line summary: N requests, X tokens, $est cost |

**Cost estimate:** rough $0.15/M input, $0.60/M output (Sonnet-ish averages). Labeled as estimate. Not configurable in v1.

### Color reuse

The djb2-of-first-8-chars hash from `__colorEscapeForModel` in `lib/log.js` is replicated in the dashboard's `app.js` so the same model renders the same color in `tail -f router.log` and in the dashboard. The 12-color palette is exposed as CSS custom properties.

## Service definitions

| Service | Binary | Port | Log files |
|---|---|---|---|
| `com.claude-mixed-models.router` (unchanged) | `router/server.js` | 8788 | `router.log`, `router.err.log` |
| `com.claude-mixed-models.stats` (new) | `scripts/server.mjs` | 8789 (via child) | `stats/server.log`, `stats/server.err.log` |

`scripts/install-services.sh` (renamed from `install-router-service.sh`) installs both. `package.json`'s `install-service` script is renamed to `install-services`.

**State directory:** all files live under `STATS_STATE_DIR` (default `/tmp/claude-mixed-models/`). `STATS_PORT` defaults to 8789. Both go in `.env.example`.

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
