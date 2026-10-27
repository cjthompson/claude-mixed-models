import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import { otherEventsPath } from '../../lib/event.js';
import { logger } from '../../lib/logger.js';

const JSONL_PATH = process.env.STATS_EVENTS_FILE ?? '/tmp/claude-mixed-models/router.events.jsonl';
const DB_PATH    = process.env.STATS_DB_PATH ?? `${process.env.HOME}/.local/state/claude-mixed-models/router.stats.db`;
const SCHEMA_PATH = new URL('../schema.sql', import.meta.url).pathname;

// Compute the start of the 5m/1h/1d bucket a given timestamp falls into.
function bucketStart(tsIso, grain) {
  const d = new Date(tsIso);
  if (grain === '1d') {
    return d.toISOString().slice(0, 10);   // 'YYYY-MM-DD'
  }
  const minutes = grain === '5m' ? 5 : 60;
  const m = d.getUTCMinutes();
  const floored = Math.floor(m / minutes) * minutes;
  d.setUTCMinutes(floored, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

function bucketEnd(bucketIso, grain) {
  const d = new Date(bucketIso);
  if (grain === '1d') {
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const minutes = grain === '5m' ? 5 : 60;
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

// Add columns the schema introduced after the table was first created.
// SQLite has no `ADD COLUMN IF NOT EXISTS`, so we check PRAGMA table_info
// first. Each entry: { table, column, type }. The function is a no-op
// for any column that's already present.
//
// Entries with `kind: 'drop_not_null'` relax an existing NOT NULL
// constraint. SQLite supports `ALTER TABLE … ALTER COLUMN … DROP NOT NULL`
// as of 3.35.0; node:sqlite bundles a SQLite that has it. They're
// separate from column-add entries because the idempotency check is
// different (PRAGMA table_info reports `notnull` rather than presence).
//
// Entries with `kind: 'backfill_events_real_model_null'` rewrite old
// events whose real_model was captured equal to model (= no redirect,
// per the pre-null contract) to NULL — the new contract treats them the
// same as fresh no-redirect events. Without this, GROUP BY model,
// real_model splits each historical model into two groups until the old
// events age out of every query window.
const MIGRATIONS = [
  { table: 'events',   column: 'effort',               type: 'TEXT' },
  // 2026-06-13: cache TTL split + thinking tokens
  { table: 'events',   column: 'cache_5m_input_tokens', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'events',   column: 'cache_1h_input_tokens', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'events',   column: 'thinking_tokens',       type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'rollup_5m', column: 'cache_5m',             type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'rollup_5m', column: 'cache_1h',             type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'rollup_5m', column: 'thinking',             type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'rollup_1h', column: 'cache_5m',             type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'rollup_1h', column: 'cache_1h',             type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'rollup_1h', column: 'thinking',             type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'rollup_1d', column: 'cache_5m',             type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'rollup_1d', column: 'cache_1h',             type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'rollup_1d', column: 'thinking',             type: 'INTEGER NOT NULL DEFAULT 0' },
  // 2026-09-25: real_model — NULL on events means "no redirect", and ''
  // (sentinel) on rollups means the same thing. rollup real_model is
  // part of the PK so a route change mid-bucket creates two rollup rows
  // instead of clobbering one. The rollup tables are dropped and
  // recreated in applyMigrations() when the PK doesn't yet include
  // real_model — old rollup data is rebuilt from events by fullRefreshGrain.
  { kind: 'drop_not_null', table: 'events',    column: 'real_model' },
  { table: 'rollup_5m', column: 'real_model', type: "TEXT NOT NULL DEFAULT ''" },
  { table: 'rollup_1h', column: 'real_model', type: "TEXT NOT NULL DEFAULT ''" },
  { table: 'rollup_1d', column: 'real_model', type: "TEXT NOT NULL DEFAULT ''" },
  { kind: 'backfill_events_real_model_null' },
];

// Rollup tables whose PRIMARY KEY doesn't yet include `real_model` are
// from a pre-real_model schema and must be rebuilt. SQLite can't ALTER a
// PK in place, so we drop the table — schema CREATE below re-creates it
// with the new PK, and fullRefreshGrain on the next startup repopulates
// it from events. A table with no PK at all (the legacy CREATE TABLE
// AS SELECT shape from a manual downgrade) is also dropped, since the
// new PK can't be added in place.
function dropStaleRollups(db) {
  for (const grain of ['5m', '1h', '1d']) {
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(`rollup_${grain}`);
    if (!exists) continue;
    const pkCols = db.prepare(`SELECT name FROM pragma_table_info('rollup_${grain}') WHERE pk > 0 ORDER BY pk`).all().map((r) => r.name);
    if (!pkCols.includes('real_model')) {
      db.exec(`DROP TABLE rollup_${grain}`);
      // Clear the matching rollup_refresh entry so the next refreshTick
      // doesn't skip this grain as "recently refreshed" and leave the
      // freshly-recreated (empty) rollup table unpopulated. Without
      // this, the 1h/1d refresh on the post-migration startup compares
      // against a pre-drop timestamp and skips — historical data is then
      // missing from those tables until enough wall-clock time passes
      // for the refresh interval to elapse.
      db.prepare('DELETE FROM rollup_refresh WHERE grain = ?').run(grain);
    }
  }
}

function applyMigrations(db) {
  // Group by table so each PRAGMA table_info fires once, not once per column.
  const byTable = new Map();
  for (const m of MIGRATIONS) {
    if (m.kind === 'drop_not_null' || m.kind === 'backfill_events_real_model_null') {
      // Handled below — different idempotency check than column-add.
      continue;
    }
    if (!byTable.has(m.table)) byTable.set(m.table, []);
    byTable.get(m.table).push(m);
  }
  for (const [table, cols] of byTable) {
    // Skip tables that don't exist yet — the schema CREATE run by
    // openAndMigrateDb() handles them on a fresh DB. ALTER TABLE
    // ADD COLUMN requires the table to exist.
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    if (!exists) continue;
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const { column, type } of cols) {
      if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  // Relax NOT NULL on existing columns. Idempotent: skip when the column
  // is already nullable (the default for fresh installs).
  for (const m of MIGRATIONS) {
    if (m.kind !== 'drop_not_null') continue;
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(m.table);
    if (!exists) continue;
    const col = db.prepare(`PRAGMA table_info(${m.table})`).all().find((c) => c.name === m.column);
    if (col && col.notnull === 1) {
      db.exec(`ALTER TABLE ${m.table} ALTER COLUMN ${m.column} DROP NOT NULL`);
    }
  }
  // One-time data backfill: events recorded before the NULL-means-no-redirect
  // contract have real_model = model for passthrough traffic. Rewrite those
  // to NULL so a fresh install and an upgraded install produce identical
  // GROUP BY model, real_model results. Idempotent: only runs if there are
  // rows to fix (a fresh DB has nothing to update).
  const eventsTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='events'`).get();
  if (eventsTable) {
    db.exec(`UPDATE events SET real_model = NULL WHERE real_model = model AND real_model IS NOT NULL`);
  }
}

// Open (creating if needed), apply the schema, run any pending
// migrations. Returns the open DatabaseSync so the caller can prepare
// statements. Called even when the JSONL is empty/absent, so the DB is
// always up-to-date before we either insert events or exit early.
//
// Order matters: dropStaleRollups() drops any rollup tables whose PK
// is missing `real_model` BEFORE the schema CREATE runs, so the
// schema CREATE can install the new PK on a fresh table rather than
// no-op'ing on the legacy shape. applyMigrations() then handles the
// additive migrations (column-adds, NOT NULL drops, backfill) on the
// post-schema tables.
function openAndMigrateDb(dbPath, schemaPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  dropStaleRollups(db);
  db.exec(readFileSync(schemaPath, 'utf8'));
  applyMigrations(db);
  return db;
}

// Compute p50 and p95 of an array of numbers (sorting is fine; buckets are small).
function percentiles(arr) {
  if (arr.length === 0) return { p50: null, p95: null };
  const sorted = [...arr].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: p(0.5), p95: p(0.95) };
}

// Recompute one rollup row from the events table for the given
// (bucket, model, real_model, upstream) tuple. real_model is part of the
// rollup PK, so events with different real_models within the same
// (bucket, model, upstream) form separate rollup rows — events that
// spanned a route change end up split correctly instead of being
// clobbered. realModel is a string ('' = no redirect) so the rollup
// column never sees a NULL value, which would let duplicate rows slip
// past ON CONFLICT (SQLite treats each NULL in a composite PK as
// distinct).
function recomputeRollup(db, grain, bucketStartIso, model, realModel, upstream) {
  const bucketEndIso = bucketEnd(bucketStartIso, grain);
  const rows = db.prepare(`
    SELECT duration_ms, status, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
           cache_5m_input_tokens, cache_1h_input_tokens, thinking_tokens
    FROM events
    WHERE ts >= ? AND ts < ? AND model = ? AND upstream = ?
      AND COALESCE(real_model, '') = ?
  `).all(bucketStartIso, bucketEndIso, model, upstream, realModel);
  const requests = rows.length;
  const errors = rows.filter((r) => r.status >= 400).length;
  const input_tokens  = rows.reduce((s, r) => s + r.input_tokens, 0);
  const output_tokens = rows.reduce((s, r) => s + r.output_tokens, 0);
  const cache_read    = rows.reduce((s, r) => s + r.cache_read_input_tokens, 0);
  const cache_write   = rows.reduce((s, r) => s + r.cache_creation_input_tokens, 0);
  const cache_5m      = rows.reduce((s, r) => s + r.cache_5m_input_tokens, 0);
  const cache_1h      = rows.reduce((s, r) => s + r.cache_1h_input_tokens, 0);
  const thinking      = rows.reduce((s, r) => s + r.thinking_tokens, 0);
  const { p50, p95 } = percentiles(rows.map((r) => r.duration_ms));
  db.prepare(`
    INSERT INTO rollup_${grain} (bucket_start, model, real_model, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, cache_5m, cache_1h, thinking, p50_ms, p95_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bucket_start, model, real_model, upstream) DO UPDATE SET
      requests = excluded.requests,
      errors = excluded.errors,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read = excluded.cache_read,
      cache_write = excluded.cache_write,
      cache_5m = excluded.cache_5m,
      cache_1h = excluded.cache_1h,
      thinking = excluded.thinking,
      p50_ms = excluded.p50_ms,
      p95_ms = excluded.p95_ms
  `).run(bucketStartIso, model, realModel, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, cache_5m, cache_1h, thinking, p50, p95);
}

// One pass: read all lines, insert events, recompute touched rollup buckets, truncate.
// SQLite result codes that mean "this record is bad" rather than "the database
// is unwell": 1299 = NOT NULL, 275 = CHECK. A bind TypeError is likewise about
// the value. Anything else (busy 5, locked 6, readonly 8, I/O 10, full 13,
// schema mismatch 1, trigger aborts, ...) must not divert good data: it aborts
// the pass so the file is kept and the next tick retries automatically.
const DATA_ERRCODES = new Set([1299, 275]);
export function isDataError(err) {
  if (!err) return false;
  if (err.code === 'ERR_INVALID_ARG_TYPE') return true;
  return err.code === 'ERR_SQLITE_ERROR' && DATA_ERRCODES.has(err.errcode);
}

// If at least this many lines reached the database and ALL failed with data
// errors, the cause is more likely systemic (e.g. code/schema mismatch) than
// bad records, so abort instead of diverting a whole batch.
const BREAKER_THRESHOLD = 5;

// Lines that cannot become a row (unparseable, no string `model`, or an insert
// that throws) are moved to `rejectedPath` with a `rejectReason` instead of
// failing the pass: the file is only truncated after a commit, so one bad line
// would otherwise be retried forever and block every event behind it.
export async function runOnce({ jsonlPath = JSONL_PATH, dbPath = DB_PATH, schemaPath = SCHEMA_PATH, rejectedPath = otherEventsPath(jsonlPath), breakerThreshold = BREAKER_THRESHOLD } = {}) {
  // Read lines first, before opening the DB — if reading fails, the JSONL is unchanged.
  let lines;
  try {
    const text = readFileSync(jsonlPath, 'utf8');
    lines = text.split('\n').filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Still need to ensure the DB exists and is migrated. An empty
      // (or absent) JSONL doesn't mean "no work to do" — schema/migration
      // runs are part of opening the DB.
      openAndMigrateDb(dbPath, schemaPath).close();
      return { inserted: 0, rejected: 0, truncated: false };
    }
    throw err;
  }
  if (lines.length === 0) {
    // Same as above: the DB might not exist yet, and an existing DB
    // might still need a schema migration. Run the open+migrate step
    // even with no events to ingest.
    openAndMigrateDb(dbPath, schemaPath).close();
    return { inserted: 0, rejected: 0, truncated: false };
  }

  const db = openAndMigrateDb(dbPath, schemaPath);

  // ON CONFLICT .. DO NOTHING (not OR IGNORE): only a duplicate (id, ts) from a
  // retried line is skipped silently. OR IGNORE would also swallow NOT NULL and
  // CHECK violations, dropping bad rows with no error and no reject record.
  const insertEvent = db.prepare(`
    INSERT INTO events (id, ts, model, real_model, effort, upstream, status, duration_ms, session_id,
                                  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
                                  cache_5m_input_tokens, cache_1h_input_tokens, thinking_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id, ts) DO NOTHING
  `);

  const touched = new Set();   // `${grain}|${bucketStart}|${model}|${realModel}|${upstream}`
  let inserted = 0;
  let attempted = 0;      // lines that reached the database
  let dbRejected = 0;     // of those, how many failed with a data error
  const rejected = [];
  db.exec('BEGIN');
  try {
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch {
        rejected.push({ rawLine: line, rejectReason: 'unparseable JSON' });
        continue;
      }
      if (rec === null || typeof rec !== 'object' || typeof rec.model !== 'string' || rec.model === '') {
        rejected.push({ ...(rec !== null && typeof rec === 'object' ? rec : { rawLine: line }), rejectReason: 'missing or non-string model' });
        continue;
      }
      // The router writes 'cache_read_input_tokens' / 'cache_creation_input_tokens' / 'sessionId';
      // normalize to the column names used in the schema. `rec.real_model`
      // is null when no redirect happened; node:sqlite rejects `undefined`
      // for bound parameters, so coerce a missing key to null too.
      const realModel = rec.real_model === undefined ? null : (rec.real_model ?? null);
      let result;
      attempted++;
      try {
        result = insertEvent.run(
          rec.id, rec.ts, rec.model, realModel, rec.effort ?? null, rec.upstream, rec.status, rec.durationMs,
          rec.sessionId ?? null,
          rec.input_tokens ?? 0, rec.output_tokens ?? 0,
          rec.cache_read_input_tokens ?? 0, rec.cache_creation_input_tokens ?? 0,
          rec.cache_5m_input_tokens ?? 0, rec.cache_1h_input_tokens ?? 0, rec.thinking_tokens ?? 0,
        );
      } catch (err) {
        // A failed statement leaves the surrounding transaction intact, so a
        // bad record can be skipped. Non-data errors propagate (rollback + retry).
        if (!isDataError(err)) throw err;
        dbRejected++;
        rejected.push({ ...rec, rejectReason: err.message });
        continue;
      }
      if (result.changes > 0) {
        inserted++;
        // Sentinel '' represents null real_model in the rollup PK; events
        // with no redirect (realModel === null) and events whose real_model
        // was lost during a parser hiccup both land in the same rollup
        // bucket, which is fine because their counts both belong to
        // "alias served by its own model".
        const rollupRealModel = realModel ?? '';
        for (const grain of ['5m', '1h', '1d']) {
          touched.add(`${grain}|${bucketStart(rec.ts, grain)}|${rec.model}|${rollupRealModel}|${rec.upstream}`);
        }
      }
    }
    if (attempted >= breakerThreshold && dbRejected === attempted) {
      throw new Error(`circuit breaker: all ${attempted} lines that reached the database failed with data errors (last: ${rejected.at(-1)?.rejectReason}); keeping the file instead of diverting it`);
    }
    for (const key of touched) {
      const [grain, bs, model, rollupRealModel, upstream] = key.split('|');
      recomputeRollup(db, grain, bs, model, rollupRealModel, upstream);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();

  // Persist rejects before truncating: if this throws, the main file is kept
  // and the next pass retries (inserts are idempotent), so nothing is lost.
  if (rejected.length > 0) {
    mkdirSync(dirname(rejectedPath), { recursive: true });
    appendFileSync(rejectedPath, rejected.map((r) => JSON.stringify(r) + '\n').join(''));
    logger.warn(`[stats-batcher] moved ${rejected.length} rejected event(s) to ${rejectedPath}`);
  }

  // Truncate only after a successful commit. If truncate fails, the next pass will
  // re-process — ON CONFLICT DO NOTHING plus recompute-from-events makes that safe.
  writeFileSync(jsonlPath, '');
  return { inserted, rejected: rejected.length, truncated: true };
}

const FULL_REFRESH_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000, '1d': 24 * 60 * 60_000 };

// Full recompute of all rollup buckets for one grain, then update last_refresh.
function fullRefreshGrain(db, grain) {
  const events = db.prepare('SELECT DISTINCT ts, model, real_model, upstream FROM events').all();
  const seen = new Set();
  db.exec('BEGIN');
  try {
    for (const { ts, model, real_model, upstream } of events) {
      const bs = bucketStart(ts, grain);
      // '' sentinel so the rollup key never contains NULL — SQLite would
      // treat each NULL in the composite PK as distinct and skip ON CONFLICT.
      const rollupRealModel = real_model ?? '';
      const key = `${bs}|${model}|${rollupRealModel}|${upstream}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recomputeRollup(db, grain, bs, model, rollupRealModel, upstream);
    }
    db.prepare('INSERT OR REPLACE INTO rollup_refresh (grain, last_refresh) VALUES (?, ?)').run(grain, new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return seen.size;
}

// runOnce() is synchronous and transactional, so a signal can only be
// delivered between ticks (never mid-commit). On a stop request, run one
// last flush before exiting so events appended since the previous tick are
// saved to the DB rather than left pending in the JSONL until the process
// next starts — still far faster than waiting for the 10s safety timer.
// Guards against a duplicate signal (e.g. SIGTERM then SIGINT) re-entering
// the flush. Always emits a final log line so the operator can tell from
// shutdown output whether no flush was needed, the flush succeeded, or it
// failed. Exported (and the flush/exit functions injectable) so tests can
// drive the handler directly instead of sending real process signals.
export function installShutdown({ runOnceFn = runOnce, exit = process.exit } = {}) {
  let shuttingDown = false;
  const onShutdownSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    return runOnceFn()
      .then((result) => {
        const inserted = result?.inserted ?? 0;
        if (inserted === 0) {
          logger.info('[stats-batcher] shutdown: no pending events to flush');
        } else {
          logger.info(`[stats-batcher] shutdown: flushed ${inserted} event(s) to DB`);
        }
      })
      .catch((err) => logger.error('[stats-batcher] shutdown: final flush failed:', err.message))
      .finally(() => exit(0));
  };
  process.on('SIGTERM', onShutdownSignal);
  process.on('SIGINT',  onShutdownSignal);
  return {
    onShutdownSignal,
    get shuttingDown() { return shuttingDown; },
    // Test-only seam: each test calls installShutdown() fresh, so without
    // this every test run would leave another pair of listeners on
    // `process`, accumulating toward Node's MaxListeners warning.
    uninstall() {
      process.removeListener('SIGTERM', onShutdownSignal);
      process.removeListener('SIGINT', onShutdownSignal);
    },
  };
}

// Long-running mode: fs.watch with a 10s safety timer. Re-arms on every flush.
async function mainLoop() {
  installShutdown();

  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      logger.error('[stats-batcher] runOnce error:', err.message);
    }
  };

  // Watch the file; tick on every 'change' AND on a 10s safety timer.
  try {
    watch(JSONL_PATH, { persistent: true }, () => { tick(); });
  } catch {
    // File may not exist yet; the 10s timer will pick up the first events.
  }
  setInterval(tick, 10_000);

  // Periodic full rollup refresh — each grain on its own schedule.
  // Runs immediately on startup (last_refresh defaults to epoch), then
  // re-checks every minute to see if any grain is due.
  const refreshTick = () => {
    const db = openAndMigrateDb(DB_PATH, SCHEMA_PATH);
    try {
      const now = Date.now();
      for (const grain of ['5m', '1h', '1d']) {
        const row = db.prepare('SELECT last_refresh FROM rollup_refresh WHERE grain = ?').get(grain);
        const age = row ? now - new Date(row.last_refresh).getTime() : Infinity;
        if (age >= FULL_REFRESH_MS[grain]) {
          const n = fullRefreshGrain(db, grain);
          logger.info(`[stats-batcher] full refresh ${grain}: ${n} buckets`);
        }
      }
    } catch (err) {
      logger.error('[stats-batcher] refresh error:', err.message);
    } finally {
      db.close();
    }
  };
  // Fire at :01, :06, :11 ... (1 minute after each 5-minute boundary) so the
  // just-closed bucket has had time to fully drain before we recompute it.
  const REFRESH_INTERVAL_MS = 5 * 60_000;
  const REFRESH_OFFSET_MS   = 60_000;
  const phase = Date.now() % REFRESH_INTERVAL_MS;
  const msUntilNext = phase < REFRESH_OFFSET_MS
    ? REFRESH_OFFSET_MS - phase
    : REFRESH_INTERVAL_MS - phase + REFRESH_OFFSET_MS;
  setTimeout(() => {
    refreshTick();
    setInterval(refreshTick, REFRESH_INTERVAL_MS);
  }, msUntilNext);
  refreshTick();   // always run on startup

  await tick();   // immediate first pass in case there's a backlog
}

// `runOnce` is exported for tests. If invoked directly (as the entry point), start the main loop.
if (import.meta.url === `file://${process.argv[1]}`) {
  mainLoop().catch((err) => {
    logger.error('[stats-batcher] fatal:', err);
    process.exit(1);
  });
}
