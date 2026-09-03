import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync, watch } from 'node:fs';
import { dirname } from 'node:path';

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
const MIGRATIONS = [
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
];
function applyMigrations(db) {
  // Group by table so each PRAGMA table_info fires once, not once per column.
  const byTable = new Map();
  for (const m of MIGRATIONS) {
    if (!byTable.has(m.table)) byTable.set(m.table, []);
    byTable.get(m.table).push(m);
  }
  for (const [table, cols] of byTable) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const { column, type } of cols) {
      if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

// Open (creating if needed), apply the schema, run any pending
// migrations. Returns the open DatabaseSync so the caller can prepare
// statements. Called even when the JSONL is empty/absent, so the DB is
// always up-to-date before we either insert events or exit early.
function openAndMigrateDb(dbPath, schemaPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
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

// Recompute one rollup row from the events table.
function recomputeRollup(db, grain, bucketStartIso, model, upstream) {
  const bucketEndIso = bucketEnd(bucketStartIso, grain);
  const rows = db.prepare(`
    SELECT duration_ms, status, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
           cache_5m_input_tokens, cache_1h_input_tokens, thinking_tokens
    FROM events
    WHERE ts >= ? AND ts < ? AND model = ? AND upstream = ?
  `).all(bucketStartIso, bucketEndIso, model, upstream);
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
    INSERT INTO rollup_${grain} (bucket_start, model, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, cache_5m, cache_1h, thinking, p50_ms, p95_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bucket_start, model, upstream) DO UPDATE SET
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
  `).run(bucketStartIso, model, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, cache_5m, cache_1h, thinking, p50, p95);
}

// One pass: read all lines, insert events, recompute touched rollup buckets, truncate.
export async function runOnce({ jsonlPath = JSONL_PATH, dbPath = DB_PATH, schemaPath = SCHEMA_PATH } = {}) {
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
      return { inserted: 0, truncated: false };
    }
    throw err;
  }
  if (lines.length === 0) {
    // Same as above: the DB might not exist yet, and an existing DB
    // might still need a schema migration. Run the open+migrate step
    // even with no events to ingest.
    openAndMigrateDb(dbPath, schemaPath).close();
    return { inserted: 0, truncated: false };
  }

  const db = openAndMigrateDb(dbPath, schemaPath);

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                                  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
                                  cache_5m_input_tokens, cache_1h_input_tokens, thinking_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const touched = new Set();   // `${grain}|${bucketStart}|${model}|${upstream}`
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      // The router writes 'cache_read_input_tokens' / 'cache_creation_input_tokens' / 'sessionId';
      // normalize to the column names used in the schema.
      const result = insertEvent.run(
        rec.id, rec.ts, rec.model, rec.real_model, rec.upstream, rec.status, rec.durationMs,
        rec.sessionId ?? null,
        rec.input_tokens ?? 0, rec.output_tokens ?? 0,
        rec.cache_read_input_tokens ?? 0, rec.cache_creation_input_tokens ?? 0,
        rec.cache_5m_input_tokens ?? 0, rec.cache_1h_input_tokens ?? 0, rec.thinking_tokens ?? 0,
      );
      if (result.changes > 0) {
        inserted++;
        for (const grain of ['5m', '1h', '1d']) {
          touched.add(`${grain}|${bucketStart(rec.ts, grain)}|${rec.model}|${rec.upstream}`);
        }
      }
    }
    for (const key of touched) {
      const [grain, bs, model, upstream] = key.split('|');
      recomputeRollup(db, grain, bs, model, upstream);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();

  // Truncate only after a successful commit. If truncate fails, the next pass will
  // re-process — INSERT OR IGNORE plus recompute-from-events makes that safe.
  writeFileSync(jsonlPath, '');
  return { inserted, truncated: true };
}

const FULL_REFRESH_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000, '1d': 24 * 60 * 60_000 };

// Full recompute of all rollup buckets for one grain, then update last_refresh.
function fullRefreshGrain(db, grain) {
  const events = db.prepare('SELECT DISTINCT ts, model, upstream FROM events').all();
  const seen = new Set();
  db.exec('BEGIN');
  try {
    for (const { ts, model, upstream } of events) {
      const bs = bucketStart(ts, grain);
      const key = `${bs}|${model}|${upstream}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recomputeRollup(db, grain, bs, model, upstream);
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
          console.log('[stats-batcher] shutdown: no pending events to flush');
        } else {
          console.log(`[stats-batcher] shutdown: flushed ${inserted} event(s) to DB`);
        }
      })
      .catch((err) => console.error('[stats-batcher] shutdown: final flush failed:', err.message))
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
      console.error('[stats-batcher] runOnce error:', err.message);
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
          console.log(`[stats-batcher] full refresh ${grain}: ${n} buckets`);
        }
      }
    } catch (err) {
      console.error('[stats-batcher] refresh error:', err.message);
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
    console.error('[stats-batcher] fatal:', err);
    process.exit(1);
  });
}
