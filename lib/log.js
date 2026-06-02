import { randomBytes } from 'node:crypto';

// 8 lowercase hex chars from 4 random bytes. e.g. '4f7a9b2c'.
// Pure function — no shared state. Each call is independent so concurrent
// requests get independent ids.
export function newRequestId() {
  return randomBytes(4).toString('hex');
}

// Current local time as 'HH:MM:SS' (24h, zero-padded). e.g. '01:23:45'.
// Reads new Date() at call time — no caching across calls, so concurrent
// log lines get distinct timestamps.
export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// REQ field order. Absent fields (undefined/null) are omitted from the line —
// no empty key=value pairs, no `n/a`. Order is fixed so log lines are
// visually diffable across requests.
const REQ_ORDER = ['method', 'url', 'model', 'route', 'upstream', 'user'];

// Test seam: production code reads `now()` instead of `timestamp()` directly,
// so tests can stub it via __setNowForTest. ES module namespace objects are
// sealed in Node, so the timestamp export itself can't be monkey-patched.
let _now = timestamp;
export function __setNowForTest(fn) { _now = fn; }

// fields: { method, url, model?, route?, upstream, user? }
export function logReq(id, fields) {
  console.log(`[${_now()} REQ ${id}] ${formatKv(REQ_ORDER, fields)}`);
}

// RES field order. Same omission rule as REQ.
const RES_ORDER = ['upstream', 'status', 'duration', 'input', 'output', 'cache_read', 'cache_write', 'total'];

// fields: { upstream, status, durationMs: number, usage?: object | null }
// durationMs is rendered as `duration=<n>ms`; the other usage fields come
// from formatUsage(usage).
export function logRes(id, fields) {
  const base = formatKv(RES_ORDER, {
    upstream: fields.upstream,
    status: fields.status,
  });
  // duration gets the 'ms' suffix; other fields don't.
  const durationPart = fields.durationMs != null
    ? ` duration=${fields.durationMs}ms`
    : '';
  console.log(`[${_now()} RES ${id}] ${base}${durationPart}${formatUsage(fields.usage)}`);
}

// Internal: build ' key1=val1 key2=val2 ...' from `order` and `fields`,
// skipping keys whose value is null or undefined.
function formatKv(order, fields) {
  const out = [];
  for (const key of order) {
    const v = fields[key];
    if (v == null) continue;
    out.push(`${key}=${v}`);
  }
  return out.join(' ');
}

// Internal: usage is the object returned by extractUsageFromSse (or the
// JSON body's .usage). Returns ' input=N output=N cache_read=N
// cache_write=N total=N' with present fields only, in that fixed order.
// Returns '' for null/undefined/non-object usage.
function formatUsage(usage) {
  if (usage == null || typeof usage !== 'object') return '';
  const map = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
    total: usage.total_tokens,
  };
  const out = [];
  for (const key of ['input', 'output', 'cache_read', 'cache_write', 'total']) {
    const v = map[key];
    if (v == null) continue;
    out.push(`${key}=${v}`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}
