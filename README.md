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
The router emits a JSONL event per request. A separate `com.claude-mixed-models.stats`
agent (`scripts/server.mjs`) batches those events into a SQLite database and serves
a self-hosted dashboard at `http://localhost:8789`, plus a terminal view via `npm run stats`.
See [`docs/operations/stats-services.md`](docs/operations/stats-services.md) for install / restart / state-file details.

See `docs/superpowers/plans/` for the full plan.
