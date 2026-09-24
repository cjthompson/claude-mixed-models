# `lib/logger.js` implementation plan

## Context

The codebase currently logs via raw `console.log`/`console.error` scattered
across `router/server.js`, `proxy/server.js`, `stats/workers/*.mjs`,
`bin/stats-cli.mjs`, `lib/event.js`, and `scripts/server.backoff.mjs`, with
no way to control verbosity — diagnostic-only lines (e.g. the `[diag]`
cache-control probe in `proxy/server.js`, or the `[tool-compat]` shim
notice in `router/server.js`) always print, and there's no way to quiet
down to just warnings/errors in production. `lib/log.js` already owns the
REQ/RES access-log line format (`logReq`/`logRes`), consumed by both
servers.

This plan adds a `lib/logger.js` module with leveled `debug`/`info`/`warn`/`error`
methods gated by `LOG_LEVEL`/`DEBUG`, plus `logger.req`/`logger.res` that
delegate to the existing `logReq`/`logRes` formatters, and migrates every
in-scope `console.*()` diagnostic call site to use it.

### Observability changes (intentional)

- `[tool-compat] injected input_schema...` (router) and `[diag] cache_control_present=...`
  (proxy) move from **always printed** to **`debug`-only**. Operators who relied on
  seeing shim activity in `router.err.log` must set `DEBUG=1` (or `LOG_LEVEL=debug`).
- The router's cleartext-upstream notice moves from `console.error` (unconditional) to
  `logger.warn` — still on stderr, but suppressed at `LOG_LEVEL=error`.
- `scripts/server.backoff.mjs` lines are split by severity (see below); the
  healthy-exit line is `info` and disappears at `LOG_LEVEL=warn`+.

## Design: `lib/logger.js`

New file at `lib/logger.js`. ESM (matches the rest of the repo — `"type": "module"`,
no `require` anywhere). Exports a single `logger` object:

```js
import { logReq, logRes } from './log.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const SILENT_VALUES = new Set(['silent', 'none', 'off']);

// Re-read on every call (not cached at import) so a changed env is picked
// up immediately and tests can toggle LOG_LEVEL/DEBUG per-test without
// re-importing the module.
function threshold() {
  if (process.env.DEBUG) return LEVELS.debug;
  const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (SILENT_VALUES.has(raw)) return LEVELS.silent;
  return Object.hasOwn(LEVELS, raw) ? LEVELS[raw] : LEVELS.info;
}

function write(level, args) {
  if (LEVELS[level] < threshold()) return;
  // Look up the console method at call time — do NOT hoist/cache this.
  // Tests capture output by reassigning console.log / console.error
  // directly; a cached reference would bypass their capture.
  const sink = (level === 'error' || level === 'warn') ? console.error : console.log;
  sink(...args);
}

export const logger = {
  debug: (...args) => write('debug', args),
  info:  (...args) => write('info', args),
  warn:  (...args) => write('warn', args),
  error: (...args) => write('error', args),
  req: (id, fields) => { if (threshold() < LEVELS.silent) logReq(id, fields); },
  res: (id, fields) => { if (threshold() < LEVELS.silent) logRes(id, fields); },
};
```

Key decisions:
- **Threshold is inclusive**: `LOG_LEVEL=info` logs `info`, `warn`, `error` (not `debug`) — standard logging-library semantics.
- **`DEBUG`**: any non-empty value forces the `debug` threshold, overriding `LOG_LEVEL`.
- **Default `LOG_LEVEL`** when unset or unrecognized: `'info'`. Surrounding whitespace is trimmed (`' debug '` → `debug`).
- **`req`/`res` are effectively the highest tier**: they print regardless of `LOG_LEVEL`/`DEBUG`, and are only silenced by `LOG_LEVEL=silent` (aliases `none`/`off`).
- **Console sink**: `debug`/`info` → `console.log`; `warn`/`error` → `console.error`. Looked up dynamically inside `write()` (see code comment) so existing tests that reassign `console.log = fn` / `console.error = fn` keep working unmodified.
- **`lib/log.js` is unchanged** — `logReq`/`logRes` keep calling `console.log` directly; `logger.req`/`logger.res` are thin delegates so there's exactly one owner of the REQ/RES line shape.

## Migrating call sites

Judgment call per call site (not a mechanical find-replace) — reclassify
where the current console method doesn't match the message's real severity.

**Program output is not logging.** Primary stdout of CLIs/scripts (the
`stats-cli` report, the `debug-webfetch-400` result lines) stays on
`console.log` so `LOG_LEVEL=warn` can't blank a user-invoked command. Only
their error paths go through the logger.

| Pattern | Maps to |
|---|---|
| Startup/shutdown lifecycle messages (banners, `[shutdown] ...`) | `logger.info` |
| Failure/error messages (`[ROUTER UPSTREAM ERROR]`, `[REQ ERROR]`, `query error`, `fatal`, etc.) | `logger.error` |
| `router/server.js` `warnIfInsecureUpstream` cleartext-credential notice | `logger.warn` (reclassified from `console.error`) |
| `router/server.js` `[tool-compat] injected input_schema...` notice | `logger.debug` (reclassified — see Observability changes) |
| `proxy/server.js` `[diag] id=... cache_control_present=...` | `logger.debug` |
| `logReq(...)`/`logRes(...)` call sites in `router/server.js` and `proxy/server.js` | `logger.req(...)` / `logger.res(...)` |
| `bin/stats-cli.mjs` report output (`renderCards`, `no data yet`) | **unchanged** — stays `console.log` (program output) |
| `bin/stats-cli.mjs` `console.error('error:', ...)` | `logger.error` |
| `scripts/debug-webfetch-400.mjs` report/result lines | **unchanged** — stays `console.log` (program output) |
| `scripts/debug-webfetch-400.mjs` transport-error branch (`✗ transport error`, `is the router running?` hint) | `logger.error` |
| `scripts/server.backoff.mjs` default `log` | level-aware: healthy exit → `info`, retry → `warn`, give-up → `error` |
| `lib/event.js` `logEvent` failure line | `logger.error` |

**Explicitly out of scope**: `stats/public/app.js` and
`stats/public/chart.min.js` — plain `<script src>` browser files with no
module system; they cannot `import` an ESM `lib/logger.js`.

### File-by-file changes

#### `router/server.js` and `proxy/server.js` — atomic import swap

The import change (dropping `logReq`/`logRes`) and the replacement of every
`logReq(`/`logRes(` call site **must land in the same edit/commit** — the
file won't load in between. After editing, `grep -n 'logReq\|logRes' <file>`
must return only `logger.req`/`logger.res` hits.

#### `router/server.js`

1. Replace the `lib/log.js` import with:
   ```js
   import { newRequestId, sessionIdFromUserId } from '../lib/log.js';
   import { logger } from '../lib/logger.js';
   ```
   (keep any other names currently imported from `lib/log.js`; only drop `logReq`, `logRes`).
2. `logReq(id, ...)` → `logger.req(id, ...)`; `logRes(id, ...)` in `finalize()` → `logger.res(id, ...)`. **Same edit as step 1.**
3. `warnIfInsecureUpstream`: `console.error(...)` → `logger.warn(...)`.
4. `applyToolCompat`: `[tool-compat]` `console.error(...)` → `logger.debug(...)`.
5. `req.on('error', (e) => console.error('[REQ ERROR]', e.message))` → `logger.error(...)`.
6. `[UPSTREAM EMPTY RESPONSE]` in `forward()` → `logger.error(...)`.
7. `[ROUTER UPSTREAM ERROR]` in `upstreamReq.on('error')` → `logger.error(...)`.
8. `installShutdown`: `[shutdown]` `console.log` → `logger.info`; `server.close` error `console.error` → `logger.error`.
9. Entry-point banner (`Router on http://...`, `Mapped routes:`, `Everything else → ...`, color banner) → `logger.info(...)`.

#### `proxy/server.js`

1. Replace the `lib/log.js` import as above (drop `logReq`, `logRes`; add `logger`).
2. `logReq(id, ...)` → `logger.req(id, ...)`; both `logRes(id, ...)` calls (empty-response branch and success branch) → `logger.res(id, ...)`. **Same edit as step 1.**
3. `MINIMAX_API_KEY is not set. Aborting.` → `logger.error(...)`.
4. `[REQ ERROR]` → `logger.error(...)`.
5. `[diag] id=... cache_control_present=...` → `logger.debug(...)`.
6. `[UPSTREAM EMPTY RESPONSE]` → `logger.error(...)`.
7. `[UPSTREAM ERROR]` → `logger.error(...)`.
8. Startup banner (`Diagnostic proxy on http://...`, `Watching for cache_control...`) → `logger.info(...)`.

#### `stats/workers/batcher.mjs`

1. Add `import { logger } from '../../lib/logger.js';`.
2. `installShutdown`: `no pending events to flush` / `flushed N event(s)` → `logger.info`; `final flush failed` → `logger.error`.
3. `runOnce error` → `logger.error`.
4. `full refresh ${grain}: ${n} buckets` → `logger.info`.
5. `refresh error` → `logger.error`.
6. Entry-point `fatal` → `logger.error`.

#### `stats/workers/server.mjs`

1. Add `import { logger } from '../../lib/logger.js';`.
2. `[stats-server] query error:` → `logger.error(...)` (log line and the HTTP 500 stay coupled in the same `catch` — intended).
3. `[stats-server] dashboard at ...` → `logger.info(...)`.
4. `[stats-server] fatal:` → `logger.error(...)`.

#### `bin/stats-cli.mjs`

1. Add `import { logger } from '../lib/logger.js';`.
2. `console.error('error:', err.message)` (watch-mode catch) → `logger.error('error:', err.message)`.
3. Leave `console.log('no data yet')` and both `console.log(renderCards(db))` calls **unchanged**.

#### `lib/event.js`

1. Add `import { logger } from './logger.js';`.
2. `[stats] logEvent failed (dropping event):` → `logger.error(...)`.

#### `scripts/server.backoff.mjs`

The injectable `log` option keeps its `(line)` contract (tests inject
`(line) => lines.push(line)`) but gains an optional second `level` arg:

1. Add `import { logger } from '../lib/logger.js';`.
2. Default: `const log = opts.log ?? ((line, level = 'error') => logger[level](line));`
3. Pass the level at each call site in `onExit`:
   - healthy clean exit (`... healthy) — resetting retry counter`) → `log(msg, 'info')`
   - give-up (`... giving up. launchd will restart ...`) → `log(msg, 'error')`
   - respawn (`... retry N/M in Xs`) → `log(msg, 'warn')`
4. Update the header comment (`log defaults to console.error ...`) to describe the level-aware default. Note: `info` goes to stdout (`stats/server.log` under launchd), `warn`/`error` stay on stderr.

#### `scripts/debug-webfetch-400.mjs`

1. Add `import { logger } from '../lib/logger.js';`.
2. Transport-error branch: `  ✗ transport error: ${err.message}` and `  (is the router running? expected at ${ROUTER_URL})` → `logger.error(...)`.
3. All other `console.log(...)` report lines (`→ sending`, `← status=`, `FAILURES:`, `  - ${f}`, `Done.`) **unchanged**.

## Tests

### New: `lib/logger.test.js`

`node:test` + `node:assert/strict`, matching `lib/log.test.js`. Use a helper
that saves **and restores** `LOG_LEVEL`, `DEBUG`, `console.log`,
`console.error` (restore to the prior value — `delete` only if it was
originally unset):

```js
function withEnv(env, fn) {
  const saved = { LOG_LEVEL: process.env.LOG_LEVEL, DEBUG: process.env.DEBUG };
  const out = [], err = [];
  const origLog = console.log, origErr = console.error;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try { fn(); } finally {
    console.log = origLog; console.error = origErr;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return { out, err };
}
```

Cases:
1. Unset `LOG_LEVEL`/`DEBUG` → `info`/`warn`/`error` emitted, `debug` not.
2. Each of `debug`/`info`/`warn`/`error` as `LOG_LEVEL` → exactly the inclusive set emitted.
3. Sink routing: `debug`/`info` → `console.log`; `warn`/`error` → `console.error`.
4. `DEBUG=1` with `LOG_LEVEL=error` → `debug` emitted (DEBUG wins).
5. `DEBUG=''` (empty) → treated as unset.
6. `LOG_LEVEL=' DEBUG '` → debug threshold (trim + case-insensitive).
7. `LOG_LEVEL=bogus` → falls back to `info`.
8. `silent`/`none`/`off` → nothing from `debug`..`error`.
9. `req`/`res`: emitted at `LOG_LEVEL=error` (and every non-silent level); suppressed at `silent`/`none`/`off`. Assert via captured `console.log` containing the REQ/RES marker produced by `lib/log.js`.
10. Multiple args are forwarded (`logger.error('a', 'b')` → sink called with both).

### Existing tests — env isolation

`router/server.test.js`'s `captureConsoleError()` (used by the four
`warnIfInsecureUpstream` tests) must also clear `LOG_LEVEL` and `DEBUG` on
entry and restore their prior values in `restore()` — otherwise running the
suite with `LOG_LEVEL=error` (or `silent`) exported makes the "warns once"
test fail, since `logger.warn` is now threshold-gated.

Apply the same save/clear/restore to any other test helper that captures
logger-routed output (check `stats/workers/batcher.test.js` around its
`console.log`/`console.error` reassignment, and `scripts/server.backoff*.test.*`
if it relies on the default `log`).

No existing test asserts on `[tool-compat]` or `[diag]` (confirmed via grep).
If a test does need a debug-reclassified line, set `process.env.DEBUG = '1'`
with the same save/try/finally/restore-prior-value pattern — never a bare
`delete process.env.DEBUG` in `finally`.

## Documentation

Insert in `.env.example` after `DEFAULT_UPSTREAM=anthropic`:

```
# Optional: log verbosity. Accepted values: debug, info, warn, error,
# silent (aliases: none, off). Default: info. REQ/RES access lines print at
# every level except silent. Setting DEBUG to any non-empty value forces
# debug-level output regardless of LOG_LEVEL.
# LOG_LEVEL=info
# DEBUG=
```

## Verification

1. `npm test` — full suite green.
2. `LOG_LEVEL=error npm test` and `DEBUG=1 npm test` — still green (proves test env isolation).
3. Run `router/server.js` / `proxy/server.js` with no env vars — banners and REQ/RES print.
4. `LOG_LEVEL=error` — banners suppressed, REQ/RES still print.
5. `LOG_LEVEL=silent` — REQ/RES also suppressed.
6. `DEBUG=1` — `[tool-compat]` / `[diag]` lines appear.
7. `LOG_LEVEL=warn node bin/stats-cli.mjs` — card output still renders.
8. `grep -rn 'console\.' lib router proxy stats/workers bin scripts --include='*.js' --include='*.mjs' | grep -v '\.test\.'` — only the intentional program-output `console.log` calls (stats-cli, debug-webfetch-400) and `lib/log.js`/`lib/logger.js` internals remain.

## Tasks

1. [ ] Write `lib/logger.test.js` (cases above); run it — fails (module missing).
2. [ ] Create `lib/logger.js` per the Design section; `node --test lib/logger.test.js` green.
3. [ ] Migrate `router/server.js` — import swap **and** `logReq`/`logRes` → `logger.req`/`logger.res` in one edit, then the remaining console calls.
4. [ ] Migrate `proxy/server.js` — same atomic import swap, then remaining calls.
5. [ ] Migrate `stats/workers/batcher.mjs`.
6. [ ] Migrate `stats/workers/server.mjs`.
7. [ ] Migrate `bin/stats-cli.mjs` (error path only).
8. [ ] Migrate `lib/event.js`.
9. [ ] Migrate `scripts/server.backoff.mjs` (level-aware default + per-call levels + header comment).
10. [ ] Migrate `scripts/debug-webfetch-400.mjs` (transport-error branch only).
11. [ ] Update test helpers for env isolation (`router/server.test.js` `captureConsoleError`, plus any others found).
12. [ ] Update `.env.example`.
13. [ ] Verification steps 1–8.
