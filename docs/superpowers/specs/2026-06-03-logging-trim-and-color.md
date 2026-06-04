# Logging trim and value color

**Date:** 2026-06-03
**Status:** approved
**Replaces:** field-set sections of [2026-06-02-routing-logging-design.md](./2026-06-02-routing-logging-design.md). The router/proxy wiring, known gap, and proxy `[diag]` line from the prior spec are preserved unchanged.

## Goal

Make REQ/RES log lines shorter and more scannable by:

1. **Trimming low-value fields** from REQ (the request-side line carries the same information in fewer characters).
2. **Coloring the value part of `key=value`** so a `tail -f` makes routing, status, and token shape visible at a glance.
3. **Abbreviating numeric values** (`1.5k`, `10.2k`, `1.2M`) so the common cache-hit line (`input=1234 cache_read=5678`) doesn't dominate the line.

Two questions to answer, same as before:
- **Cost** — input/output/cache tokens per upstream.
- **Latency + routing** — duration, which provider, was the model rewritten.

## Non-goals

- Capturing `usage` in the router (still null; the "known gap" from the 2026-06-02 spec stands).
- A `NO_COLOR` knob or a `LOG_FIELDS=full` env var to restore dropped fields. Color is emitted unconditionally; the prior spec's "TTY check is intentionally disabled" decision extends to values, not just the bracket.
- Color in the proxy's standalone `[diag] id=… cache_control_present=…` line.
- Per-field colors that depend on the value's magnitude (only duration is traffic-light; everything else is keyed by field name or model string).
- Changing the bracket color (session-keyed, unchanged).

## Log shape

Two lines per request, prefixed with a `HH:MM:SS` timestamp and a request id. The bracket is colored by `session_id` (unchanged). The value part of each `key=value` is colored as described below; keys are uncolored.

### REQ line

```
[01:23:45 REQ 4f7a9b2c] model=MiniMax-M3 upstream=api.minimax.io
```

Field order: `model`, `upstream`. `model` is omitted when the body has no `model` field (e.g. `GET /v1/models`); `upstream` is always present.

### RES line

```
[01:23:46 RES 4f7a9b2c] upstream=minimax status=200 duration=842 [in: 1.2k | out: 42 | cache read: 5.7k | write: 120] total: 7k
```

Field order: `upstream`, `status`, `duration`, then the optional token bracket, then `total` (also optional). Token bracket fields appear in fixed order (`in`, `out`, `cache read`, `write`); absent fields are absent.

### Field omission rule

Unchanged from the 2026-06-02 spec. Absent fields are **absent from the line**. No `key=` with an empty value, no `null`, no `n/a`. Same applies inside the token bracket — if `cache_read_input_tokens` is missing from `usage`, the `cache read:` segment is omitted.

### Field order

`logReq` and `logRes` emit fields in a fixed order regardless of which keys are present.

## Value colors

### `model=`

Hash-keyed per model string. The same algorithm and 12-color palette as the existing `session_id` color (djb2 hash over the first 8 chars, mod palette size). Two requests to the same model always render the same color. The palette is shared with the bracket color, but the roles don't clash: bracket = session identity (which Claude Code session), model value = which model the call was sent to.

If `model` is absent, no value is colored.

### `upstream=`

Uncolored. The hostname is greppable, so keeping it uncolored means a plain `grep upstream=minimax` still finds the line.

### `status=`

Red for status ≥ 400. Default (uncolored) for status < 400. Status 2xx/3xx render the same as today; 4xx/5xx (including 502 from the upstream-error path) render the value in red. The intent is that a single `tail -f` highlights error lines without needing a filter.

### `duration=`

Traffic-light by `durationMs`:

- `< 1000` → green
- `1000 ≤ durationMs < 5000` → yellow
- `durationMs ≥ 5000` → red

Status ≥ 400 forces red regardless of ms (an error is bad even if it's fast).

### Token bracket fields

Each field name has a fixed color; the value is wrapped in that color. Colors do not depend on the value's magnitude.

| Field         | Color         | ANSI         |
|---------------|---------------|--------------|
| `in`          | cyan          | `\x1b[36m`   |
| `out`         | magenta       | `\x1b[35m`   |
| `cache read`  | blue          | `\x1b[34m`   |
| `write`       | yellow        | `\x1b[33m`   |
| `total`       | bold white    | `\x1b[1;37m` |

The brackets (`[`, `]`, `|`, `:`) and the literal field names (`in`, `out`, `cache read`, `write`, `total`) are uncolored. Only the numeric value is wrapped in the field's color, so `grep 'in: 1.2k'` still finds the line.

## Numeric abbreviation

A pure function `abbrev(n)` formats integer counts:

| Range                  | Format    | Examples                          |
|------------------------|-----------|-----------------------------------|
| `n < 1000`             | raw       | `0`, `42`, `842`, `999`           |
| `1000 ≤ n < 10000`     | `Xk` or `X.Yk` | `1234` → `1.2k`, `2000` → `2k` |
| `10000 ≤ n < 1_000_000`| `Xk` or `X.Yk` | `10234` → `10.2k`, `100000` → `100k` |
| `n ≥ 1_000_000`        | `XM` or `X.YM` | `1_500_000` → `1.5M`, `2_000_000` → `2M` |

Rules:
- One decimal place when the abbreviated value has a non-zero fractional part; otherwise the decimal and trailing zero are dropped. So `1.5k` (1500), `1.2k` (1234), but `2k` (2000), `100k` (100000).
- The decimal-rule applies to each range. `10000` → `10k` (had to drop a digit), `100000` → `100k` (rounded integer).
- Negative numbers: pass through unchanged. (Shouldn't occur, but the function is a pure formatter, not a validator.)
- `0` stays `0` (no `0k`).

The function is used for both duration and the token counts in the bracket and `total:`. The `ms` suffix on duration is dropped — `duration=842`, not `duration=842ms`. The field name carries the unit; the missing suffix keeps the line narrow.

## File / non-TTY behavior

Color is emitted unconditionally. The bracket color is already unconditional ("TTY check is intentionally disabled" per the 2026-06-02 spec); value color follows the same rule. Piping through `cat`, `less -R`, `tee`, or any file sink produces a stream of bytes that includes the ANSI escape sequences. The literal key names, brackets, and field structure are identical to the uncolored version, so `grep` works on either terminal or file output.

## `lib/log.js` — additions

New internal helpers and one new internal function. The public surface (`newRequestId`, `timestamp`, `logReq`, `logRes`, `sessionIdFromUserId`, `__setNowForTest`) is unchanged; the new functions are file-internal and exported only for tests.

```js
// 12-color palette shared with the bracket session color.
const VALUE_COLORS = [33, 36, 32, 35, 34, 31, 37, 208, 129, 46, 196, 220];

// djb2 hash over the first 8 chars of `s`, mapped to the palette.
function colorEscapeForModel(s) { /* … */ }

// Returns the ANSI escape for the value of durationMs at the given status.
function colorEscapeForDuration(ms, status) { /* … */ }

// Returns the ANSI escape for a status code (red on ≥400, '' otherwise).
function colorEscapeForStatus(status) { /* … */ }

// Field name → ANSI escape, or '' for the empty/default case.
const TOKEN_COLOR = {
  in: '\x1b[36m',           // cyan
  out: '\x1b[35m',          // magenta
  cache_read: '\x1b[34m',   // blue
  write: '\x1b[33m',        // yellow
  total: '\x1b[1;37m',      // bold white
};

// Format an integer count as '1.5k' / '10.2k' / '1.2M' per the table above.
function abbrev(n) { /* … */ }
```

### `formatUsage(usage)` — reworked

Returns the new token bracket shape:

```
' [in: 1.2k | out: 42 | cache read: 5.7k | write: 120] total: 7k'
```

Behavior:
- `null` / `undefined` / non-object → `''`.
- Each present token count is abbreviated via `abbrev()` and wrapped in the field's color from `TOKEN_COLOR`. Field names, brackets, pipes, colons, and the spaces between them are uncolored.
- Field order is fixed: `in`, `out`, `cache read`, `write`, then `total` outside the bracket.
- Absent fields are omitted from the bracket. `total` is also omitted when `total_tokens` is absent — it does not get computed from the others.

### `logReq(id, fields)` — reworked

Field set shrinks from `{ method, url, model?, route?, upstream, user? }` to `{ model?, upstream }`. The router and proxy callers are updated accordingly:

```js
logReq(id, { model: parsedBody?.model, upstream: conn.url.host });
```

Implementation:
- Bracket colored by `session` (unchanged).
- If `model` is present, render `model=<colorEscapeForModel(model)><model><reset>`. Otherwise, omit the `model=` segment entirely.
- `upstream` is always rendered uncolored.

### `logRes(id, fields)` — reworked

Field set unchanged at the call site (`{ upstream, status, durationMs, usage, session? }`). The output format changes:

- `upstream` uncolored.
- `status` colored by `colorEscapeForStatus`.
- `duration=<abbrev(durationMs)>` (no `ms` suffix), value colored by `colorEscapeForDuration`.
- After the duration, append `formatUsage(usage)` (which already begins with a space if non-empty).

## Router wiring (`router/server.js`)

Caller update — REQ-side call becomes:

```js
logReq(id, {
  model: parsedBody?.model,
  upstream: conn.url.host,
  session,
});
```

`session` is still threaded through (`sessionIdFromUserId(parsedBody?.metadata?.user_id)`) so the bracket color works. The other fields (`method`, `url`, `route`, `user`) are removed from the call. The `route` field is dropped entirely — the router still mutates `body.model` to the real model before forwarding, and the REQ line's `model=` reflects the rewritten model. RES-side call is unchanged.

The upstream-error path (the `502` handler) is unchanged in shape: it calls `logRes` with `status: 502`, which automatically colors the status red and the duration red (because status ≥ 400).

## Proxy wiring (`proxy/server.js`)

Caller update — REQ-side call becomes:

```js
logReq(id, {
  model: parsed?.model,
  upstream: UPSTREAM.host,
  session: sessionIdFromUserId(parsed?.metadata?.user_id),
});
```

The proxy's standalone `[diag] id=… cache_control_present=true|false` line is preserved. The RES-side call is unchanged.

## Files changed

- **Modified:** `lib/log.js` — new internal helpers, reworked `logReq` / `logRes` / `formatUsage` / `formatKv`.
- **Modified:** `lib/log.test.js` — update existing assertions to the trimmed shape, add new tests for the helpers.
- **Modified:** `router/server.js` — `logReq` call drops `method`, `url`, `route`, `user`. Remove the now-dead `route` logic from the call shape (the routing decision still happens; only the logging changes).
- **Modified:** `router/server.test.js` — update existing assertions to the trimmed REQ shape (no `user=`, no `route=`, no `method=`, no `url=`).
- **Modified:** `proxy/server.js` — `logReq` call drops `method`, `url`, `user`.
- **Modified:** `CHANGELOG.md` — add an entry describing the trim and color.

## Files NOT changed

- `router/routes.js`, `router/routes.config.json`
- `proxy/inspect.js`, `proxy/inspect.test.js` — `extractUsageFromSse` and `hasCacheControl` are unchanged
- `scripts/run-router.sh`, `scripts/run-diagnostic.sh`
- `.env.example`, `.env`, `package.json`
- `docs/superpowers/specs/2026-06-02-routing-logging-design.md` — kept for history. The prior spec's "known gap" (router doesn't capture usage) and the omission/field-order rules still apply; only the field set is superseded.

## Testing

`lib/log.test.js`:

1. `newRequestId`, `timestamp` — unchanged, existing tests stay.
2. `logReq` REQ-line shape — `logReq('id', { model: 'X', upstream: 'Y' })` produces `[<ts> REQ id] model=X upstream=Y` (with model value wrapped in the model's hash color). Test stubs `timestamp` for exact-line assertions, and stubs `colorEscapeForModel` to return a known escape for a sentinel model name.
3. `logReq` with no `model` — produces `[<ts> REQ id] upstream=Y` (no `model=` segment).
4. `logReq` with `session` — bracket is color-wrapped, same as today.
5. `logRes` shape — `logRes('id', { upstream: 'minimax', status: 200, durationMs: 842, usage: {…} })` produces the new format. Assertion covers the literal bracketing, pipe, and total-outside-bracket.
6. `logRes` status ≥ 400 — `status=` value is wrapped in red.
7. `logRes` status 200 — `status=` value is uncolored.
8. `logRes` duration traffic-light — stub `durationMs` to 500 / 3000 / 6000 and assert green / yellow / red.
9. `logRes` duration red override — `status: 502, durationMs: 50` produces red `duration=` even though ms < 1000.
10. `logRes` token bracket — usage with all five fields produces `[in: 1.2k | out: 42 | cache read: 5.7k | write: 120] total: 7k`; usage with only `input_tokens` and `output_tokens` produces `[in: 1.2k | out: 42] total: 1.2k` (no empty `cache read:` / `write:`).
11. `logRes` token bracket colors — each field's value is wrapped in its `TOKEN_COLOR` escape. Test asserts the exact escape sequence around the value.
12. `abbrev` — covers `0`, `1`, `999`, `1000`, `1234`, `2000`, `9999`, `10000`, `10234`, `100000`, `999999`, `1_000_000`, `1_500_000`, `2_000_000`. Asserts the exact string.
13. `colorEscapeForModel` — same model string returns the same escape; two distinct models return different escapes for at least one pair (probabilistic; one test pair is enough).
14. `colorEscapeForStatus` — `200` → `''`, `400` → red, `502` → red.
15. `colorEscapeForDuration` — `500` / `3000` / `6000` → green / yellow / red. `50, status=502` → red.

`router/server.test.js`:

16. The three existing REQ tests lose their `assert.match` lines for `method=`, `url=`, `route=`, `user=`. The test for the mapped route now asserts `model=MiniMax-M3` and `upstream=api.minimax.io` only. The unmapped-passthrough test asserts no `route=` and no `user=`. The bodyless GET test asserts no `model=`, no `user=`, no `method=`, no `url=`. (The test name and intent stay the same; the body of the assertion changes.)
17. The 502 forward test still asserts the RES line exists with `status=502`. No other changes.

`proxy/inspect.test.js`:

18. Unchanged. The trim doesn't touch SSE parsing or `hasCacheControl`.

## How to apply

After implementation, `tail -f` the router or proxy:

```
[01:23:45 REQ 4f7a9b2c] model=MiniMax-M3 upstream=api.minimax.io
[01:23:46 RES 4f7a9b2c] upstream=minimax status=200 duration=842 [in: 1.2k | out: 42 | cache read: 5.7k | write: 120] total: 7k
```

`grep 4f7a9b2c` gives the whole transaction. `grep status=` finds status lines; lines with a red `status=` value jump out without filtering. The model value's stable color tells you at a glance which upstream served which Claude Code session. The token bracket makes cache hit/miss shape readable: a heavy cache hit shows `in: 50 | cache read: 45k` (large cache_read, small input); a fresh prompt shows the opposite.
