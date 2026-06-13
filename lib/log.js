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

// Format a millisecond duration as a human-friendly string:
//   < 1000 ms   → "#ms"   (e.g. "5ms", "999ms")
//   < 60_000 ms → "#.#s"  (e.g. "1.2s", "30s" — drop trailing .0)
//   ≥ 60_000 ms → "#m #s" (e.g. "1m 5s", "2m 30s")
// Negative inputs pass through unchanged — the duration is a measurement,
// not a delta, and a negative is more likely a bug than a real value.
export function __formatDuration(ms) {
  if (ms < 0) return String(ms);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    const rounded = Math.round(s * 10) / 10;
    // Crossing the 60s boundary by rounding: bump to the minute form so we
    // never emit "60s" / "60.1s".
    if (rounded >= 60) {
      const minutes = Math.floor(rounded / 60);
      const seconds = Math.round(rounded - minutes * 60);
      return `${minutes}m ${seconds}s`;
    }
    return rounded + 's';
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms - minutes * 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Returns the ANSI escape for a status code value. Red on >= 400, '' otherwise.
export function __colorEscapeForStatus(status) {
  return status >= 400 ? '\x1b[31m' : '';
}

// Returns the ANSI escape for a duration value. Traffic-light by ms; red
// overrides when status >= 400 (an error is bad even if it's fast).
export function __colorEscapeForDuration(durationMs, status) {
  if (status >= 400) return '\x1b[31m';
  if (durationMs >= 5000) return '\x1b[31m';
  if (durationMs >= 1000) return '\x1b[33m';
  return '\x1b[32m';
}

export function __colorEscapeForModel(model) {
  const colorCode = SESSION_COLORS[hashSession(model) % SESSION_COLORS.length];
  return colorCode < 38
    ? `\x1b[${colorCode}m`
    : `\x1b[38;5;${colorCode}m`;
}

// REQ field order. Absent fields (undefined/null) are omitted from the line —
// no empty key=value pairs, no `n/a`. Order is fixed so log lines are
// visually diffable across requests.
const REQ_ORDER = ['model', 'upstream'];

// Test seam: production code reads `now()` instead of `timestamp()` directly,
// so tests can stub it via __setNowForTest. ES module namespace objects are
// sealed in Node, so the timestamp export itself can't be monkey-patched.
let _now = timestamp;
export function __setNowForTest(fn) { _now = fn; }

// fields: { model?, upstream, session? }
// `model` is omitted entirely when absent; the `model=` value is wrapped in
// `colorEscapeForModel(model)`. `upstream` is uncolored so a plain
// `grep upstream=minimax` still finds the line.
export function logReq(id, fields) {
  const bracket = colorBracket(`[${_now()} REQ ${id}]`, fields.session);
  const colors = fields.model ? { model: __colorEscapeForModel(fields.model) } : {};
  console.log(`${bracket} ${formatKv(REQ_ORDER, fields, colors)}`);
}

// RES field order. Same omission rule as REQ: null/undefined fields absent.
const RES_ORDER = ['upstream', 'status', 'duration'];

// fields: { upstream, status, durationMs: number, usage?: object | null, session? }
// durationMs is rendered as `duration=<abbrev(ms)>` (no 'ms' suffix); usage
// is rendered via formatUsage(usage) in the new bracket shape.
export function logRes(id, fields) {
  const base = formatKv(RES_ORDER, {
    upstream: fields.upstream,
    status: fields.status,
  }, {
    status: __colorEscapeForStatus(fields.status),
  });
  let durationPart = '';
  if (fields.durationMs != null) {
    const dur = __formatDuration(fields.durationMs);
    const esc = __colorEscapeForDuration(fields.durationMs, fields.status);
    const RESET = '\x1b[0m';
    durationPart = ` duration=${esc}${dur}${RESET}`;
  }
  const bracket = colorBracket(`[${_now()} RES ${id}]`, fields.session);
  console.log(`${bracket} ${base}${durationPart}${formatUsage(fields.usage)}`);
}

// Internal: build ' key1=val1 key2=val2 ...' from `order` and `fields`,
// skipping keys whose value is null or undefined. `colors` (optional) is a
// map of field name → ANSI escape to wrap the value in. After a colored
// value, a reset escape ('\x1b[0m') is emitted so the next field renders
// in default style. Unlisted fields render uncolored.
function formatKv(order, fields, colors = {}) {
  const RESET = '\x1b[0m';
  const out = [];
  for (const key of order) {
    const v = fields[key];
    if (v == null) continue;
    const esc = colors[key];
    if (esc) {
      out.push(`${key}=${esc}${v}${RESET}`);
    } else {
      out.push(`${key}=${v}`);
    }
  }
  return out.join(' ');
}

// Field name → ANSI escape. Only the value is wrapped; brackets, pipes,
// colons, and literal field names are uncolored so `grep 'in: 1.2k'` still
// finds the line. The internal key for cache_read uses an underscore for
// code readability; the bracket label uses a space ('cache read:').
const TOKEN_COLOR = {
  in: '\x1b[36m',           // cyan
  out: '\x1b[35m',          // magenta
  cache_read: '\x1b[34m',   // blue
  write: '\x1b[33m',        // yellow
  total: '\x1b[1;37m',      // bold white
};

const RESET = '\x1b[0m';

// Internal: usage is the object returned by extractUsageFromSse (or the
// JSON body's .usage). Returns the token bracket shape:
//   ' [in: N | out: N | cache read: N | write: N] total: N'
//   ' [in: N | out: N | cache read: N | write: N (5m: A | 1h: B)] total: N'
//   ' [in: N | out: N | think: N | cache read: N | write: N] total: N'
// Field order is fixed; absent fields are omitted entirely (no 'n/a',
// no empty segments). `total` is omitted when total_tokens is absent —
// it is not computed from the others. The cache-write segment gets a
// parenthetical TTL split only when BOTH 5m and 1h are nonzero; if only
// one TTL is used the bracket stays compact.
// Returns '' for null/undefined/non-object usage.
function formatUsage(usage) {
  if (usage == null || typeof usage !== 'object') return '';
  const bracket = [];
  const push = (label, value, colorKey) => {
    if (value == null) return;
    bracket.push(`${label}: ${TOKEN_COLOR[colorKey]}${__abbrev(value)}${RESET}`);
  };
  push('in', usage.input_tokens, 'in');
  push('out', usage.output_tokens, 'out');
  // Thinking tokens are informational — they don't add to the user-visible
  // output count (output_tokens already includes them). Show the segment
  // only when the model actually did some thinking; otherwise the bracket
  // stays clean and the Haiku case (where the field is always 0) renders
  // the same as before normalizeUsage.
  const thinking = usage.output_tokens_details?.thinking_tokens;
  if (thinking != null && thinking > 0) {
    push('think', thinking, 'total');
  }
  push('cache read', usage.cache_read_input_tokens, 'cache_read');
  // Build the write segment with an optional TTL split. If the upstream
  // reported the cache_creation nest (Anthropic's actual shape) and both
  // TTLs are nonzero, expand the value to "N (5m: A | 1h: B)". Otherwise
  // keep the compact "N" form so the bracket doesn't get noisy.
  const writeTotal = usage.cache_creation_input_tokens;
  if (writeTotal != null) {
    const c5  = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const c1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const split = c5 > 0 && c1h > 0
      ? ` (5m: ${TOKEN_COLOR.write}${__abbrev(c5)}${RESET} | 1h: ${TOKEN_COLOR.write}${__abbrev(c1h)}${RESET})`
      : '';
    bracket.push(`write: ${TOKEN_COLOR.write}${__abbrev(writeTotal)}${RESET}${split}`);
  }
  const segments = [];
  if (bracket.length) segments.push(`[${bracket.join(' | ')}]`);
  if (usage.total_tokens != null) {
    segments.push(`total: ${TOKEN_COLOR.total}${__abbrev(usage.total_tokens)}${RESET}`);
  }
  return segments.length ? ' ' + segments.join(' ') : '';
}
