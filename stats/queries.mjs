// Pure data layer: one function per dashboard card.
// All functions take a `DatabaseSync` and a `range` string ('24h' | '7d' | '30d' | 'all').
// No formatting, no HTTP, no I/O. Both the HTTP server and the CLI call these.

// Range → SQLite datetime threshold (UTC). Returns the ISO string for `WHERE ts >= ?`.
// 'all' returns no threshold (caller handles the no-filter case).
function rangeThreshold(range) {
  const now = new Date();
  switch (range) {
    case '1h':  now.setUTCHours(now.getUTCHours() - 1); break;
    case '5h':  now.setUTCHours(now.getUTCHours() - 5); break;
    case '24h': now.setUTCDate(now.getUTCDate() - 1); break;
    case '7d':  now.setUTCDate(now.getUTCDate() - 7); break;
    case '30d': now.setUTCDate(now.getUTCDate() - 30); break;
    case 'all': return null;
    default: throw new Error(`unknown range: ${range}`);
  }
  return now.toISOString();
}

function rollupTable(range) {
  if (range === '1h' || range === '5h') return 'rollup_5m';
  if (range === '30d' || range === 'all') return 'rollup_1d';
  return 'rollup_1h';
}

// `tsCol` is the time column to filter on: 'ts' for the raw events table,
// 'bucket_start' for the rollup tables (both store ISO-8601 UTC strings, so a
// lexicographic `>=` comparison against the threshold is correct).
function withRange(range, whereClause = '1=1', tsCol = 'ts') {
  const t = rangeThreshold(range);
  return t ? `${whereClause} AND ${tsCol} >= ?` : whereClause;
}

function bindRange(range, ...rest) {
  const t = rangeThreshold(range);
  return t ? [...rest, t] : rest;
}

// Stacked bar chart source. The server stays UTC-neutral; the viewer groups
// these timestamped buckets into local labels at the JSON boundary.
// real_model is included so the frontend can show "Haiku 4.5 (→ MiniMax-M3)"
// when an alias was redirected, and aggregate per-real-model totals.
export function tokensByBucket(db, range = '30d') {
  const table = (range === '1h' || range === '5h') ? 'rollup_5m' : 'rollup_1h';
  return db.prepare(`
    SELECT bucket_start AS bucket, model, real_model,
           SUM(input_tokens + cache_read + cache_write + output_tokens) AS tokens
    FROM ${table}
    WHERE ${withRange(range, '1=1', 'bucket_start')}
    GROUP BY bucket, model, real_model
    ORDER BY bucket, model
  `).all(...bindRange(range))
    .map((r) => ({ bucket: r.bucket, model: r.model, real_model: normalizeRealModel(r.real_model), tokens: Number(r.tokens) }))
    .filter((r) => Number.isFinite(r.tokens));
}

// Per-hour request counts over the window, one row per rollup_1h bucket.
// The frontend buckets these by *browser-local* hour-of-day so the chart
// reflects each viewer's timezone (a server-UTC deployment would otherwise
// show the wrong hours for everyone not on UTC).
export function requestsByHourOfDay(db, range = '7d') {
  return db.prepare(`
    SELECT bucket_start, SUM(requests) AS requests
    FROM rollup_1h
    WHERE ${withRange(range, '1=1', 'bucket_start')}
    GROUP BY bucket_start
  `).all(...bindRange(range)).map((r) => ({ bucket: r.bucket_start, requests: Number(r.requests) }));
}

// Cache hit rate raw counts per (alias, real_model) tuple. Returns the
// cache_read and the uncached-context denominator so the frontend can
// combine across aliases that canonicalize to the same display name
// (you can't merge ratios by averaging them — the cached-context share
// has to be re-derived from the underlying counts).
export function cacheHitRateByModel(db, range = '7d') {
  return db.prepare(`
    SELECT model, real_model,
           SUM(cache_read) AS cache_read,
           SUM(input_tokens) AS input_tokens,
           SUM(cache_read + cache_write + input_tokens) AS context_tokens
    FROM ${rollupTable(range)}
    WHERE ${withRange(range, '1=1', 'bucket_start')}
    GROUP BY model, real_model
    ORDER BY context_tokens DESC
  `).all(...bindRange(range))
    .map((r) => ({
      model: r.model,
      real_model: normalizeRealModel(r.real_model),
      cache_read: Number(r.cache_read ?? 0),
      input_tokens: Number(r.input_tokens ?? 0),
      context_tokens: Number(r.context_tokens ?? 0),
    }));
}

export function topModels(db, range = '7d', limit = 5) {
  return db.prepare(`
    SELECT model, real_model,
           SUM(requests) AS requests,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(errors) AS errors,
           SUM(cache_read) AS cache_read,
           SUM(cache_write) AS cache_write,
           SUM(cache_5m) AS cache_5m,
           SUM(cache_1h) AS cache_1h,
           SUM(thinking) AS thinking
    FROM ${rollupTable(range)}
    WHERE ${withRange(range, '1=1', 'bucket_start')}
    GROUP BY model, real_model
    ORDER BY input_tokens + cache_read + cache_write DESC
    LIMIT ?
  `).all(...bindRange(range), limit).map((r) => ({ ...r, real_model: normalizeRealModel(r.real_model) }));
}

// Aggregate requests and tokens by canonical real_model across ALL
// aliases — no LIMIT. Used by the dashboard's "Total served per real
// model" summary line so the figure reflects every upstream model that
// ran in the window, not just the top-5 rows from topModels().
export function totalsByRealModel(db, range = '7d') {
  return db.prepare(`
    SELECT real_model,
           SUM(requests) AS requests,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(errors) AS errors,
           SUM(cache_read) AS cache_read,
           SUM(cache_write) AS cache_write,
           SUM(cache_5m) AS cache_5m,
           SUM(cache_1h) AS cache_1h,
           SUM(thinking) AS thinking
    FROM ${rollupTable(range)}
    WHERE ${withRange(range, '1=1', 'bucket_start')}
    GROUP BY real_model
    ORDER BY requests DESC
  `).all(...bindRange(range)).map((r) => ({ ...r, real_model: normalizeRealModel(r.real_model) }));
}

// Map the rollup real_model sentinel '' (and SQL NULL) to a uniform null
// in the API output. The frontend treats null and '' identically, but a
// uniform null keeps the JSON shape clean and matches what events-backed
// queries return for the same case.
function normalizeRealModel(value) {
  if (value == null || value === '') return null;
  return value;
}

// Total token usage grouped by the model and the effort requested for each
// event. Read raw events so the existing model-only rollup keys stay intact.
// real_model is included so the frontend can display the redirect when an
// alias routes to a different upstream model.
export function tokensByModelEffort(db, range = '7d') {
  const hasEffort = db.prepare('PRAGMA table_info(events)').all().some((column) => column.name === 'effort');
  const effortExpr = hasEffort ? "COALESCE(NULLIF(effort, ''), 'unspecified')" : "'unspecified'";
  return db.prepare(`
    SELECT model, real_model,
           ${effortExpr} AS effort,
           COUNT(*) AS requests,
           SUM(input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens) AS tokens
    FROM events
    WHERE ${withRange(range)}
    GROUP BY model, real_model, ${effortExpr}
    ORDER BY tokens DESC, model, effort
  `).all(...bindRange(range)).map((row) => ({
    model: row.model,
    real_model: row.real_model ?? null,
    effort: row.effort,
    requests: Number(row.requests),
    tokens: Number(row.tokens),
  })).filter((row) => Number.isFinite(row.tokens));
}

export function topSessions(db, range = '7d', limit = 5) {
  return db.prepare(`
    SELECT session_id,
           COUNT(*) AS requests,
           SUM(input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens) AS tokens,
           MIN(ts) AS first_ts,
           MAX(ts) AS last_ts
    FROM events
    WHERE session_id IS NOT NULL ${withRange(range, '')}
    GROUP BY session_id
    ORDER BY requests DESC
    LIMIT ?
  `).all(...bindRange(range), limit);
}

// Thinking tokens per model, ranked desc. Models with no thinking
// activity (Haiku, non-thinking Sonnet turns) are excluded so the
// dashboard can show "Opus did the thinking" without zero rows
// cluttering the card. real_model lets the frontend label redirected
// aliases correctly.
export function thinkingByModel(db, range = '7d') {
  return db.prepare(`
    SELECT model, real_model, SUM(thinking) AS thinking
    FROM ${rollupTable(range)}
    WHERE ${withRange(range, 'thinking > 0', 'bucket_start')}
    GROUP BY model, real_model
    ORDER BY thinking DESC
  `).all(...bindRange(range));
}

export function errorsByStatus(db, range = '24h') {
  return db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM events
    WHERE status >= 400 ${withRange(range, '')}
    GROUP BY status
    ORDER BY count DESC
  `).all(...bindRange(range));
}

export function todaysTotals(db) {
  const today = new Date().toISOString().slice(0, 10);   // 'YYYY-MM-DD' (UTC)
  return db.prepare(`
    SELECT
      COALESCE(SUM(requests), 0)      AS requests,
      COALESCE(SUM(input_tokens), 0)  AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read), 0)    AS cache_read,
      COALESCE(SUM(cache_write), 0)   AS cache_write,
      COALESCE(SUM(thinking), 0)      AS thinking
    FROM rollup_1d
    WHERE bucket_start = ?
  `).get(today) ?? { requests: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, thinking: 0 };
}

export function rangeTotals(db, range = '7d') {
  if (range === '30d' || range === 'all') {
    return db.prepare(`
      SELECT
        COALESCE(SUM(requests), 0)      AS requests,
        COALESCE(SUM(input_tokens), 0)  AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read), 0)    AS cache_read,
        COALESCE(SUM(cache_write), 0)   AS cache_write,
        COALESCE(SUM(thinking), 0)      AS thinking
      FROM rollup_1d
    `).get() ?? { requests: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, thinking: 0 };
  }
  return db.prepare(`
    SELECT
      COALESCE(SUM(requests), 0)      AS requests,
      COALESCE(SUM(input_tokens), 0)  AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read), 0)    AS cache_read,
      COALESCE(SUM(cache_write), 0)   AS cache_write,
      COALESCE(SUM(thinking), 0)      AS thinking
    FROM ${rollupTable(range)}
    WHERE ${withRange(range, '1=1', 'bucket_start')}
  `).get(...bindRange(range)) ?? { requests: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, thinking: 0 };
}
