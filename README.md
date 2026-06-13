# claude-mixed-models

Run Claude Code with both Anthropic and MiniMax models via a tiny local router.

- `proxy/` — Phase 0 throwaway diagnostic that checks whether prompt caching survives to MiniMax.
- `router/` — the real multi-upstream router. Point Claude Code's `ANTHROPIC_BASE_URL` at it.
- `.claude/agents/` — role-split subagents that pick a provider by model alias.

## Quick start
1. `cp .env.example .env` and fill in keys.
2. Phase 0: `npm run proxy` then in another shell `scripts/run-diagnostic.sh`. Read `proxy/server.js` log output.
3. Phase 1+: `npm run router` then `scripts/run-router.sh`.

## Running as a service
To run the router as a persistent background service (auto-restart on crash, auto-start on login), see [`docs/operations/router-as-service.md`](docs/operations/router-as-service.md).

## Usage stats
The router emits a JSONL event per request. The `com.claude-mixed-models.stats`
launchd agent runs `scripts/server.mjs`, a single orchestrator that supervises
the router, the stats batcher, and the stats HTTP dashboard as child processes.
The batcher rolls events up into a SQLite database, which the dashboard serves
at `http://localhost:8789`. There's also a terminal view via `npm run stats`.
Requires Node 22.5+ (built-in `node:sqlite`); no third-party dependencies.

### Install
```bash
cp .env.example .env
# edit .env to change default settings (ports, state-file paths) — defaults work as-is

# install the single launchd agent (orchestrator that supervises router + stats)
scripts/install-services.sh

# verify the dashboard is up (returns JSON, possibly empty until traffic flows)
curl -sf "http://localhost:8789/api/stats?range=24h"

# view stats in the browser
open http://localhost:8789

# view stats in the terminal (live)
npm run stats -- --range=24h --watch
```

### Restart
```bash
launchctl stop  gui/$(id -u)/com.claude-mixed-models.stats
launchctl start gui/$(id -u)/com.claude-mixed-models.stats
```
This restarts the orchestrator, which in turn restarts the router, the batcher,
and the dashboard HTTP server. There is no separate router agent.

### Uninstall
```bash
scripts/install-services.sh uninstall
```

### Dashboard
A dark-themed single page at [`http://localhost:8789`](http://localhost:8789) with a
range selector (24h / 7d / 30d / all) and these cards, refreshing every 10s:
- **Today** — total requests, input tokens, output tokens
- **Tokens per day** — stacked bar, one color per model
- **Requests by hour-of-day** — 24-bucket bar chart
- **Cache hit rate by model** — bar chart (percent)
- **Top models** — requests / in / out / errors
- **Top sessions** — requests and tokens per session
- **Errors (last 24h)** — count by HTTP status

To add a screenshot: open the dashboard and save an image to
`docs/images/stats-dashboard.png`, then reference it here.

### Terminal view (`npm run stats`)
```
Usage stats · range=24h

Today                  91 requests · 109.8k in · 15.3k out

Top models
  minimax-m2.7                     42 reqs ·   64.9k in ·     9k out ·   2.4% err
  minimax                          42 reqs ·   61.6k in ·   8.5k out ·   2.4% err
  claude-opus-4-8                  40 reqs ·     61k in ·   8.4k out ·   0.0% err

Top sessions
  12340000      32 reqs ·   56.3k tokens
  a1b2c3d4      32 reqs ·   56.6k tokens
  ee55ff66      31 reqs ·   52.8k tokens

Requests by hour-of-day
  00:00  █████████████████    6
  01:00  ████████████████████ 7
  ...
  13:00  ████████████████████ 7
  14:00  ██████████████       5

Errors (last 24h)
  502: 1
  429: 1
```
(Colorized in a real terminal; `--watch` repaints every 5s.)

See [`docs/operations/stats-services.md`](docs/operations/stats-services.md) for the
architecture diagram, endpoints, and state-file details.

## npm scripts
| Command | What it does |
| --- | --- |
| `npm test` | Run the full test suite (`node --test --test-force-exit`). |
| `npm run proxy` | Start the Phase 0 caching diagnostic proxy (`proxy/server.js`) on `PROXY_PORT` (default 8787). |
| `npm run router` | Start the multi-upstream router (`router/server.js`) on `ROUTER_PORT` (default 8788). |
| `npm run stats` | Print usage stats to the terminal (one-shot, last 7 days). |
| `npm run stats -- --range=<r>` | Set the window: `24h`, `7d`, `30d`, or `all`. |
| `npm run stats -- --watch` | Full-screen terminal view; repaints every 5s. Combine with `--range`. |
| `npm run install-services` | Install the single launchd agent (orchestrator that supervises router + stats; alias for `scripts/install-services.sh`). |

> Note: `npm run` needs `--` before script flags, e.g. `npm run stats -- --range=30d --watch`.

See `docs/superpowers/plans/` for the full plan.
