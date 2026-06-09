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
    SELECT duration_ms, status, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
    FROM events
    WHERE ts >= ? AND ts < ? AND model = ? AND upstream = ?
  `).all(bucketStartIso, bucketEndIso, model, upstream);
  const requests = rows.length;
  const errors = rows.filter((r) => r.status >= 400).length;
  const input_tokens  = rows.reduce((s, r) => s + r.input_tokens, 0);
  const output_tokens = rows.reduce((s, r) => s + r.output_tokens, 0);
  const cache_read    = rows.reduce((s, r) => s + r.cache_read_input_tokens, 0);
  const cache_write   = rows.reduce((s, r) => s + r.cache_creation_input_tokens, 0);
  const { p50, p95 } = percentiles(rows.map((r) => r.duration_ms));
  db.prepare(`
    INSERT INTO rollup_${grain} (bucket_start, model, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, p50_ms, p95_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bucket_start, model, upstream) DO UPDATE SET
      requests = excluded.requests,
      errors = excluded.errors,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read = excluded.cache_read,
      cache_write = excluded.cache_write,
      p50_ms = excluded.p50_ms,
      p95_ms = excluded.p95_ms
  `).run(bucketStartIso, model, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, p50, p95);
}

// One pass: read all lines, insert events, recompute touched rollup buckets, truncate.
export async function runOnce({ jsonlPath = JSONL_PATH, dbPath = DB_PATH, schemaPath = SCHEMA_PATH } = {}) {
  // Read lines first, before opening the DB — if reading fails, the JSONL is unchanged.
  let lines;
  try {
    const text = readFileSync(jsonlPath, 'utf8');
    lines = text.split('\n').filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return { inserted: 0, truncated: false };
    throw err;
  }
  if (lines.length === 0) return { inserted: 0, truncated: false };

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(schemaPath, 'utf8'));

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                                  input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

// Long-running mode: fs.watch with a 10s safety timer. Re-arms on every flush.
async function mainLoop() {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT',  () => { stopping = true; });

  const tick = async () => {
    if (stopping) process.exit(0);
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
  await tick();   // immediate first pass in case there's a backlog
}

// `runOnce` is exported for tests. If invoked directly (as the entry point), start the main loop.
if (import.meta.url === `file://${process.argv[1]}`) {
  mainLoop().catch((err) => {
    console.error('[stats-batcher] fatal:', err);
    process.exit(1);
  });
}
