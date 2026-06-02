# claude-mixed-models

Run Claude Code with both Anthropic and MiniMax models via a tiny local router.

- `proxy/` — Phase 0 throwaway diagnostic that checks whether prompt caching survives to MiniMax.
- `router/` — the real multi-upstream router. Point Claude Code's `ANTHROPIC_BASE_URL` at it.
- `.claude/agents/` — role-split subagents that pick a provider by model alias.

## Quick start
1. `cp .env.example .env` and fill in keys.
2. Phase 0: `npm run proxy` then in another shell `scripts/run-diagnostic.sh`. Read `proxy/server.js` log output.
3. Phase 1+: `npm run router` then `scripts/run-router.sh`.

See `docs/superpowers/plans/` for the full plan.
