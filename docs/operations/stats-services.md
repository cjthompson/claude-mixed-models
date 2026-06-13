# Usage-stats service

The stats subsystem (batcher + dashboard HTTP server) is part of the single
orchestration launchd agent (`com.claude-mixed-models.stats`). The agent
runs `scripts/server.mjs`, which supervises three child processes: the
router, the batcher, and the dashboard HTTP server. Install it with:

```bash
scripts/install-services.sh
```

This installs (or, with `scripts/install-services.sh uninstall`, removes) the
single `stats` agent. It writes logs to `stats/server.log`
and `stats/server.err.log`; tail either file to see what the orchestrator
and its children are doing. The router's REQ/RES lines interleave with the
stats workers' output in the same log files.

## Architecture

```
orchestrator (scripts/server.mjs)
  ├── router/server.js
  │     │
  │     └─append──> router.events.jsonl
  │
  ├── stats/workers/batcher.mjs
  │     └─watch──> router.stats.db (writes)
  │
  └── stats/workers/server.mjs
        └─read-only WAL──> http://127.0.0.1:8789  +  npm run stats
```

The router appends one JSON line per request to the events buffer
(best-effort — a failed append never breaks the response path). The batcher
consumes the buffer on every `fs.watch` change (plus a 10s safety timer),
inserts into the `events` table, recomputes the 5m/1h/1d rollups, and
truncates the buffer. Re-processing is safe: `INSERT OR IGNORE` on
`(id, ts)` dedupes and rollups are recomputed from `events`, never
incremented.

## Endpoints

- `GET /`                                — dashboard
- `GET /api/stats?range=24h|7d|30d|all`  — JSON for the cards

The server binds to `127.0.0.1` on `STATS_PORT` (default 8789). There is no auth —
the assumption is "only the laptop's user can reach localhost".

## CLI

```bash
npm run stats              # one-shot, last 7 days
npm run stats -- --range=24h
npm run stats -- --watch   # full-screen repaint every 5s
```

## State files

- `STATS_EVENTS_FILE` (default `/tmp/claude-mixed-models/router.events.jsonl`):
  transient write buffer; truncated by the batcher after each pass. Safe to delete
  while the router is running — the next batcher pass will just find nothing.
- `STATS_DB_PATH` (default `~/.local/state/claude-mixed-models/router.stats.db`):
  persistent SQLite database (WAL mode). Don't delete this — it's the source of
  truth. The dashboard and CLI open it read-only.

## Restarting

```bash
launchctl stop  gui/$(id -u)/com.claude-mixed-models.stats
launchctl start gui/$(id -u)/com.claude-mixed-models.stats
```

This restarts the orchestrator, which in turn restarts the router, the
batcher, and the HTTP dashboard server. There is no separate router agent —
it's supervised by the same `stats` agent.

## Requirements

Node 22.5+ (for the built-in `node:sqlite` module). No third-party dependencies;
`chart.js` is vendored at `stats/public/chart.min.js`.
