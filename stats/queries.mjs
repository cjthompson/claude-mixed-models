// Pure data layer: one function per dashboard card.
// All functions take a `DatabaseSync` and a `range` string ('24h' | '7d' | '30d' | 'all').
// No formatting, no HTTP, no I/O. Both the HTTP server and the CLI call these.

// Range → SQLite datetime threshold (UTC). Returns the ISO string for `WHERE ts >= ?`.
// 'all' returns no threshold (caller handles the no-filter case).
function rangeThreshold(range) {
  const now = new Date();
  switch (range) {
    case '24h': now.setUTCDate(now.getUTCDate() - 1); break;
    case '7d':  now.setUTCDate(now.getUTCDate() - 7); break;
    case '30d': now.setUTCDate(now.getUTCDate() - 30); break;
    case 'all': return null;
    default: throw new Error(`unknown range: ${range}`);
  }
  return now.toISOString();
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

// Stacked bar chart, 30 days, by model. The rollup already aggregates by day.
export function tokensByDay(db, range = '30d') {
  // Read from rollup_1d for the 30d case, rollup_1h for shorter windows.
  if (range === '30d' || range === 'all') {
    return db.prepare(`
      SELECT bucket_start AS date, model, SUM(input_tokens + output_tokens) AS tokens
      FROM rollup_1d
      GROUP BY date, model
      ORDER BY date, model
    `).all();
  }
  return db.prepare(`
    SELECT substr(bucket_start, 1, 10) AS date, model, SUM(input_tokens + output_tokens) AS tokens
    FROM rollup_1h
    WHERE ${withRange(range, '1=1', 'bucket_start')}
    GROUP BY date, model
    ORDER BY date, model
  `).all(...bindRange(range));
}

// 24-bucket bar chart of requests by hour-of-day, aggregated over the window.
export function requestsByHourOfDay(db, range = '7d') {
  const rows = db.prepare(`
    SELECT strftime('%H', bucket_start) AS hour, SUM(requests) AS requests
    FROM rollup_1h
    WHERE ${withRange(range, '1=1', 'bucket_start')}
    GROUP BY hour
  `).all(...bindRange(range));
  // Fill missing hours with 0 so the chart has 24 bars.
  const byHour = Object.fromEntries(rows.map((r) => [Number(r.hour), Number(r.requests)]));
  return Array.from({ length: 24 }, (_, h) => ({ hour: h, requests: byHour[h] ?? 0 }));
}

// Cache hit rate: cache_read / (input + cache_read + cache_write) per model.
export function cacheHitRateByModel(db, range = '7d') {
  return db.prepare(`
    SELECT model,
           CASE WHEN SUM(input_tokens + cache_read + cache_write) > 0
                THEN CAST(SUM(cache_read) AS REAL) / SUM(input_tokens + cache_read + cache_write)
                ELSE 0 END AS hitRate
    FROM rollup_1h
    WHERE ${withRange(range, '1=1', 'bucket_start')}
    GROUP BY model
    ORDER BY hitRate DESC
  `).all(...bindRange(range));
}

export function topModels(db, range = '7d', limit = 5) {
  return db.prepare(`
    SELECT model,
           SUM(requests) AS requests,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(errors) AS errors
    FROM rollup_1h
    WHERE ${withRange(range, '1=1', 'bucket_start')}
    GROUP BY model
    ORDER BY input_tokens DESC
    LIMIT ?
  `).all(...bindRange(range), limit);
}

export function topSessions(db, range = '7d', limit = 5) {
  return db.prepare(`
    SELECT session_id,
           COUNT(*) AS requests,
           SUM(input_tokens + output_tokens) AS tokens,
           MIN(ts) AS first_ts,
           MAX(ts) AS last_ts
    FROM events
    WHERE session_id IS NOT NULL ${withRange(range, '')}
    GROUP BY session_id
    ORDER BY requests DESC
    LIMIT ?
  `).all(...bindRange(range), limit);
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
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM rollup_1d
    WHERE bucket_start = ?
  `).get(today) ?? { requests: 0, input_tokens: 0, output_tokens: 0 };
}
