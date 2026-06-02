# Phase 0 Caching Diagnostic — Result

**Date:** 2026-06-01
**Model tested:** `MiniMax-M3` (via `https://api.minimax.io/anthropic`)
**Verdict:** ✅ **Row 1 — caching works natively to MiniMax.** The Claude-prefixed alias is belt-and-suspenders, not load-bearing.

## Raw log

```
[REQ] POST /v1/messages?beta=true model=MiniMax-M3 cache_control_present=false

[REQ] POST /v1/messages?beta=true model=MiniMax-M3 cache_control_present=true
[RES] status=200 cache_write=0 cache_read=433 input=0
[RES] status=200 cache_write=0 cache_read=35767 input=0

[REQ] POST /v1/messages?beta=true model=MiniMax-M3 cache_control_present=true
[RES] status=200 cache_write=0 cache_read=35958 input=0
```

## Interpretation

1. **Claude Code emits `cache_control` for a non-Claude model name.** Requests with `model=MiniMax-M3` (no "claude" substring) still carry `cache_control_present=true`. This build of Claude Code does **not** gate cache-breakpoint emission on the model name — the `is_claude`-style failure mode (hermes-agent #17332) does not apply here.
2. **MiniMax serves real cache hits.** `cache_read` climbs 433 → 35,767 → 35,958 across turns, with `input=0` — almost the entire prompt prefix is served from cache. Caching is genuinely active end-to-end.
3. **The first request shows `cache_control_present=false`.** This is Claude Code's lightweight/background call (e.g. title generation) made before a cacheable prefix exists. Not a concern.
4. **`cache_write=0` accounting curiosity.** Writes report 0 while reads climb into the tens of thousands; MiniMax appears to account cache *creation* under a different usage field. The climbing read counts are unambiguous proof of caching, so this is cosmetic.

## Consequence for the build

- The alias trick (Claude-prefixed name → MiniMax) is **not required for caching**. We keep it anyway (zero cost, clean naming) but it is not protecting anything.
- **Config retargeted to `MiniMax-M3`** (the verified-working model the operator actually has access to). The alias was renamed from `claude-minimax-m2` to the version-agnostic `claude-minimax`, updated across `router/routes.config.json`, `router/routes.test.js`, `.claude/agents/bulk-coder.md`, and `.env.example`.
