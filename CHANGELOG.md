# Changelog

## 2026-07-25

### Fixes
- Orchestrator (`scripts/server.mjs`) no longer forwards a duplicate SIGTERM/SIGINT to its children on a repeated signal — a second signal was hitting the router's "second SIGTERM" hard-kill path and dropping in-flight requests mid-stream during an otherwise-graceful shutdown (#router, #reliability)
- Router no longer logs a misleading `[UPSTREAM EMPTY RESPONSE]` for connections torn down by its own shutdown drain (#router, #logging)

## 2026-06-15

### Tasks
- Auto-refresh: ETag-based conditional fetch — skip redraw when stats unchanged (#stats, #performance)
- Model aliasing in stats dashboard (#stats, #models)

### Fixes
- Stats totals card reflects selected time range instead of always "today" (#stats, #ui)
- Stats viewer — selected time frame not persisted on refresh (#stats, #ui)
- Stats HTML page widget layout — add configurable width/height spans (#ui, #dashboard)

### Tasks
- Replace openssl cert generation with Node crypto (#testing, #maintenance)
- Switch SSE parser to streaming line-by-line scan (#performance, #scalability)

## 2026-06-11

### Fixes
- fix `spawn node ENOENT` in the orchestrator by spawning children with `process.execPath` (the absolute path of the Node binary) instead of the bare string `'node'` — launchd's `KeepAlive` services don't inherit the user's `PATH`, so a bare `'node'` could not be resolved in the child process

### Tasks
- consolidate router + stats into a single launchd service: `scripts/server.mjs` now supervises the router, the batcher, and the HTTP dashboard as three children; the `com.claude-mixed-models.router` plist and `install-router-service.sh` script are removed; `install-services.sh` installs only the single `com.claude-mixed-models.stats` agent
- update `docs/operations/{router-as-service,stats-services}.md` and the README to describe the single-service architecture and the new interleaved log locations (`stats/server.log` / `stats/server.err.log`)

## 2026-06-08

### Tasks
- add usage-stats service: best-effort JSONL event sink in the router, a batcher that rolls events up into SQLite (5m/1h/1d), a read-only HTTP dashboard, and a terminal CLI (#observability, #stats)
- vendored chart.js for offline dashboard rendering

## 2026-06-03

### Tasks
- expose `MiniMax-M2.7` as a cheaper MiniMax option via the `minimax-m2.7` alias
- drop the `claude-` prefix from MiniMax aliases (`claude-minimax` → `minimax`, `claude-minimax-m2.7` → `minimax-m2.7`) — verified unnecessary for caching, and shorter to type at the `/model` prompt
- trim low-value fields from REQ/RES log lines (`method`, `url`, `route`, `user` dropped) and color the value part of `key=value` so a `tail -f` makes routing, status, and token shape visible at a glance (#observability, #logging)
- abbreviate numeric values in the log line (`1.2k`, `10.2k`, `1.5M`)

## 2026-06-02

### Tasks
- colorize log lines by user session_id (#observability, #logging)
- explore options to have the router run as a persistent service
