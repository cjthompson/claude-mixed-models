-- SQLite schema for the usage-stats service.
-- Loaded by stats/workers/batcher.mjs on first open; idempotent.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;     -- safe with WAL; ~2x faster than FULL

-- Raw events: one row per router request.
-- (id, ts) is the primary key, not id alone, so a retried JSONL line
-- (same id, same timestamp) is silently dropped while a genuine
-- 32-bit id collision requires an exact-ms match to dedup.
CREATE TABLE IF NOT EXISTS events (
  id                          TEXT NOT NULL,
  ts                          TEXT NOT NULL,
  model                       TEXT NOT NULL,   -- client-requested alias
  real_model                  TEXT NOT NULL,   -- resolved upstream model
  upstream                    TEXT NOT NULL,
  status                      INTEGER NOT NULL,
  duration_ms                 INTEGER NOT NULL,
  session_id                  TEXT,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, ts)
);

CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_model    ON events(model);
CREATE INDEX IF NOT EXISTS idx_events_upstream ON events(upstream);
CREATE INDEX IF NOT EXISTS idx_events_session  ON events(session_id);

-- 5-minute rollup. The card queries primarily read from this.
-- Recomputed from `events` on every batcher pass (never incremented),
-- so a retried pass produces identical values.
CREATE TABLE IF NOT EXISTS rollup_5m (
  bucket_start  TEXT NOT NULL,   -- ISO 8601, top of 5-min window (UTC)
  model         TEXT NOT NULL,
  upstream      TEXT NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  p50_ms        INTEGER,
  p95_ms        INTEGER,
  PRIMARY KEY (bucket_start, model, upstream)
);
CREATE INDEX IF NOT EXISTS idx_5m_bucket ON rollup_5m(bucket_start);

-- Hourly rollup. Drives the 7-day "tokens/day" and cache-hit-rate cards.
CREATE TABLE IF NOT EXISTS rollup_1h (
  bucket_start  TEXT NOT NULL,
  model         TEXT NOT NULL,
  upstream      TEXT NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  p50_ms        INTEGER,
  p95_ms        INTEGER,
  PRIMARY KEY (bucket_start, model, upstream)
);
CREATE INDEX IF NOT EXISTS idx_1h_bucket ON rollup_1h(bucket_start);

-- Daily rollup. Drives the 30-day "tokens/day" card.
CREATE TABLE IF NOT EXISTS rollup_1d (
  bucket_start  TEXT NOT NULL,   -- 'YYYY-MM-DD' (UTC)
  model         TEXT NOT NULL,
  upstream      TEXT NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  p50_ms        INTEGER,
  p95_ms        INTEGER,
  PRIMARY KEY (bucket_start, model, upstream)
);
CREATE INDEX IF NOT EXISTS idx_1d_bucket ON rollup_1d(bucket_start);
