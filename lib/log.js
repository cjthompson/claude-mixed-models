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

// Extract the session_id from a metadata.user_id field. Some clients send
// user_id as a JSON-stringified object (e.g. Claude Code):
//   metadata: { user_id: '{"device_id":"…","session_id":"abc"}' }
// Others send it as a nested object directly. This helper handles both.
// Returns undefined when neither shape is present.
export function sessionIdFromUserId(userId) {
  if (userId == null) return undefined;
  if (typeof userId === 'object') return userId.session_id;
  if (typeof userId === 'string') {
    try {
      const obj = JSON.parse(userId);
      if (obj && typeof obj === 'object') return obj.session_id;
    } catch {
      // Not JSON — fall through to undefined.
    }
  }
  return undefined;
}

// ANSI 256-color palette: 12 distinct foreground colors. Sized for
// 4-8 concurrent sessions without clashing.
const SESSION_COLORS = [
  33, 36, 32, 35, 34, 31, 37,
  208, 129, 46, 196, 220,
];

// djb2 hash over the first 8 characters of the session_id.
function hashSession(s) {
  let h = 5381;
  const len = Math.min(s.length, 8);
  for (let i = 0; i < len; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

// Returns the ANSI escape sequence to color `text` using a color keyed by
// session_id, or returns `text` unmodified when session_id is absent.
// TTY check is intentionally disabled — color is emitted unconditionally so
// log output is consistent regardless of how stdout is connected.
function colorBracket(text, session) {
  if (!session) return text;
  const colorCode = SESSION_COLORS[hashSession(session) % SESSION_COLORS.length];
  const open = colorCode < 38
    ? `\x1b[${colorCode}m`
    : `\x1b[38;5;${colorCode}m`;
  return `${open}${text}\x1b[0m`;
}

// Format an integer count as a compact string. Per the 2026-06-03 spec:
//   n < 1000              → 'N' (raw)
//   1000 ≤ n < 1_000_000  → 'X.Yk' with one decimal (drop trailing .0)
//   n ≥ 1_000_000         → 'X.YM' with one decimal (drop trailing .0)
// In the k-range, the result is capped at 3 digits: if the rounded value
// reaches 1000k, jump to '1M' instead of '1000k'.
export function __abbrev(n) {
  if (n < 0) return String(n);
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    const rounded = Math.round(k * 10) / 10;
    if (rounded >= 1000) return '1M';
    return rounded + 'k';
  }
  const m = n / 1_000_000;
  return Math.round(m * 10) / 10 + 'M';
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

// fields: { method, url, model?, route?, upstream, user?, session? }
export function logReq(id, fields) {
  const bracket = colorBracket(`[${_now()} REQ ${id}]`, fields.session);
  console.log(`${bracket} ${formatKv(REQ_ORDER, fields)}`);
}

// RES field order. Same omission rule as REQ.
const RES_ORDER = ['upstream', 'status', 'duration', 'input', 'output', 'cache_read', 'cache_write', 'total'];

// fields: { upstream, status, durationMs: number, usage?: object | null, session? }
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
  const bracket = colorBracket(`[${_now()} RES ${id}]`, fields.session);
  console.log(`${bracket} ${base}${durationPart}${formatUsage(fields.usage)}`);
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
