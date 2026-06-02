# Routing observability logging

**Date:** 2026-06-02
**Status:** approved

## Goal

Make the router and proxy observable enough to answer two questions from a `tail -f` of their combined output:

1. **Cost** — per request, how many input/output/cache tokens did each upstream serve, and which upstream was it?
2. **Latency + routing** — how long did the upstream take, and was the request mapped through the router table or sent through as a passthrough?

No parser, no log shipper, no JSON — plain key=value lines that are greppable by a request id. The router and proxy stay **stateless across requests** (no shared mutable state, no per-request maps) so multiple concurrent agents can't interfere with each other's logs.

## Non-goals

- JSON-line output, structured log levels, or integration with `pino` / `winston`.
- Honoring inbound `x-request-id` headers — we always generate a server-side id.
- Per-SSE-event logging. One RES line per request, derived from the last `usage` object seen in the response.
- Per-agent identification beyond `metadata.user_id`, which is whatever the client (Claude Code) sends. We do not invent an agent side channel.
- Log file rotation, shipping, or any persistence beyond stdout.

## Log shape

Two lines per request, both prefixed with a request id:

```
[REQ 4f7a9b2c] method=POST url=/v1/messages model=claude-minimax route=MiniMax-M3 upstream=minimax user=chris
[RES 4f7a9b2c] upstream=minimax status=200 duration=842ms input=1234 output=42 cache_read=5678 cache_write=120
```

### Request id

8 lowercase hex characters from `crypto.randomBytes(4).toString('hex')`. Generated server-side per request, never reused. Both REQ and RES lines for the same request share the id, which is the only correlation handle.

### REQ fields

| Field   | Always present | Notes |
|---------|----------------|-------|
| method  | yes            | HTTP method as received |
| url     | yes            | Request path-and-query as received |
| model   | no             | Present only when the body parsed as a JSON object with a `model` field |
| route   | no             | Present only when the router rewrote the model via the routes table (e.g. `claude-minimax` → `MiniMax-M3`). Omitted for passthrough. |
| upstream| yes            | Hostname of the upstream that will serve the call (e.g. `minimax`, `api.anthropic.com`) |
| user    | no             | Present only when the parsed body has `metadata.user_id` |

### RES fields

| Field    | Always present | Notes |
|----------|----------------|-------|
| upstream | yes            | Same value as on REQ — makes it easy to scan RES lines for one upstream |
| status   | yes            | HTTP status from the upstream, or 502 if the upstream connection failed |
| duration | yes            | Integer milliseconds from "request body fully received" to "response fully returned" |
| input    | no             | `usage.input_tokens` if present |
| output   | no             | `usage.output_tokens` if present |
| cache_read | no           | `usage.cache_read_input_tokens` if present |
| cache_write | no          | `usage.cache_creation_input_tokens` if present |
| total    | no             | `usage.total_tokens` if present |

### Field omission rule

Omitted fields are **absent from the line**. No `key=` with an empty value, no `null`, no `n/a`. This is what keeps the line shape stable when MiniMax returns a slightly different usage shape than Anthropic, or when the call is a non-streaming JSON response, or when the body was a `GET /v1/models` with no model field.

### Field order

`logReq` and `logRes` emit fields in a fixed order regardless of which keys are present, so log lines from different requests are visually diffable.

## `lib/log.js` — new file

Location: `lib/log.js` at the repo root. Both `router/server.js` and `proxy/server.js` import from it.

Exports:

```js
// 8 lowercase hex chars. e.g. '4f7a9b2c'.
export function newRequestId(): string

// fields: { method, url, model?, route?, upstream, user? }
// Emits a single line via console.log:
//   [REQ 4f7a9b2c] method=POST url=/v1/messages model=claude-minimax ...
export function logReq(id: string, fields: object): void

// fields: { upstream, status, durationMs: number, usage?: object | null }
// Emits a single line via console.log:
//   [RES 4f7a9b2c] upstream=minimax status=200 duration=842ms input=1234 ...
export function logRes(id: string, fields: object): void
```

Internal:

```js
// usage is the object returned by extractUsageFromSse (or the JSON body's
// .usage). Returns ' input=N output=N cache_read=N cache_write=N total=N'
// with present fields only, in that fixed order. Returns '' for null.
function formatUsage(usage: object | null): string
```

`newRequestId` calls `crypto.randomBytes(4)` and is a pure function (no shared state). `logReq` and `logRes` build a single string and call `console.log` exactly once — no buffering, no state.

## `proxy/inspect.js` change — capture `output_tokens`

`extractUsageFromSse` currently returns the **first** `usage` object it sees in the SSE stream. Anthropic streams prompt-side usage on `message_start` and `output_tokens` on `message_delta`. To capture both with one call, change it to return the **last** `usage` object seen.

This is the only change to `inspect.js`. The function signature stays the same; the only test impact is that the existing test (if any) asserting "first usage wins" must be updated to "last usage wins."

## Router wiring (`router/server.js`)

In the request handler, after the body is fully read and the route/default-upstream decision is made, but before `forward()`:

```js
const id = newRequestId();
const t0 = Date.now();
logReq(id, {
  method: req.method,
  url: req.url,
  model: parsedBody?.model,             // parsedBody is the JS object or undefined
  route: route ? route.realModel : undefined,
  upstream: conn.url.host,
  user: parsedBody?.metadata?.user_id,
});
```

`forward()`'s signature gains `{ id, t0 }` so the response side can log:

```js
export function forward(req, res, conn, outBody, { id, t0 })
```

In the upstream response callback, after `upstreamRes.pipe(res)` finishes, call:

```js
logRes(id, {
  upstream: conn.url.host,
  status: upstreamRes.statusCode,
  durationMs: Date.now() - t0,
  usage: null,  // router pipes SSE bytes through without buffering. See "Known gap" below.
});
```

**Known gap: the router does not capture token usage.** The router pipes the upstream response straight to the client (`upstreamRes.pipe(res)`) and does not buffer it, so it has no `usage` object to log. The proxy *does* buffer and parses SSE/JSON for usage, because the proxy was built as a diagnostic. The router's RES line therefore carries `upstream`, `status`, and `duration` only — no `input=` / `output=` / `cache_*=` fields.

This is acceptable for v1 because: (a) the proxy is the place to observe MiniMax cost today; (b) the router is the place to observe latency and routing decisions; and (c) adding usage capture to the router would require buffering the response, which would change the streaming behavior — that's a real design decision, not a small change. If the router needs to capture usage, it would either buffer in memory (memory cost scales with response size) or accumulate from SSE events on the fly (state, which the spec deliberately avoids). Out of scope for v1.

On upstream error, the error handler logs a RES line with `status: 502` and `usage: null` before writing the 502 to the client. The current `[ROUTER UPSTREAM ERROR]` console.error line is removed — its information is on the RES line.

### Timing window

`t0 = Date.now()` is captured inside `req.on('end', …)`, i.e. after the request body is fully read. This is what a user perceives as "time waiting for the model." Body upload time on localhost is negligible; the alternative (capturing `t0` at the top of the handler) was rejected for being less meaningful.

## Proxy wiring (`proxy/server.js`)

Same shape. After body parse, capture `id` and `t0`, call `logReq` with `method`, `url`, `model`, `cache_control` (the existing `hasCacheControl(body)` boolean as `cache_control=true|absent`), `user`, and `upstream` (the configured upstream's host). The RES line uses `extractUsageFromSse(text)` (or the JSON `.usage` fallback) and includes status, duration, and the resulting usage object.

The proxy's existing `cache_control_present=…` REQ field is preserved — that was the whole point of the diagnostic proxy.

## Files changed

- **New:** `lib/log.js`
- **New:** `lib/log.test.js`
- **Modified:** `proxy/inspect.js` — one-line change to `extractUsageFromSse` to return the last usage object
- **Modified:** `proxy/inspect.test.js` — update or add a test asserting the new "last usage wins" behavior
- **Modified:** `router/server.js` — add REQ/RES logging, change `forward` signature, remove `[ROUTER UPSTREAM ERROR]` console.error
- **Modified:** `router/server.test.js` — adapt the existing `forward` test to the new signature; add tests asserting REQ/RES are emitted for mapped, unmapped, and bodyless paths
- **Modified:** `proxy/server.js` — replace ad-hoc `console.log` calls with `logReq` / `logRes`

## Files NOT changed

- `router/routes.js`, `router/routes.config.json`
- `scripts/run-router.sh`, `scripts/run-diagnostic.sh`
- `.env.example`, `.env`, `package.json`
- `README.md` — the quick-start already says to read the log output; no new user-facing steps

## Testing

`lib/log.test.js` covers:
1. `newRequestId` returns 8 hex chars, and two calls return different ids.
2. `logReq` emits fields in the documented order, and omits fields whose value is `undefined` / `null`.
3. `logRes` does the same for its field set.
4. `formatUsage(null)` returns `''`. `formatUsage({ input_tokens: 1, output_tokens: 2 })` returns ` input=1 output=2`. Field order is fixed.

`router/server.test.js` adds:
5. Mapped route: `logReq` is called with the routed real model, `logRes` with status and duration.
6. Unmapped passthrough: `logReq` is called with no `route` field, `upstream` set to the default upstream's host.
7. Bodyless (e.g. `GET /v1/models`): `logReq` is called with no `model` / `route`, `upstream` set to the default.
8. The existing `forward` test adapts to the new `{ id, t0 }` parameter; the assertions on 502 + "upstream error" body still hold.

`proxy/inspect.test.js` updates the SSE-usage test (if one exists) to assert the **last** usage object wins, and adds a test where `message_delta` carries `output_tokens` and the function returns it.

## How to apply

After implementation, `tail -f` the router or proxy and look for a single id across two lines:

```
[REQ 4f7a9b2c] method=POST url=/v1/messages model=claude-minimax route=MiniMax-M3 upstream=minimax user=chris
[RES 4f7a9b2c] upstream=minimax status=200 duration=842ms input=1234 output=42 cache_read=5678 cache_write=120
```

`grep 4f7a9b2c` gives the whole transaction. `grep upstream=minimax` filters by provider. `grep status=502` surfaces failed calls. The combination of `route=`, `upstream=`, and the `cache_*` fields on RES answers cost and routing questions in one line each.
