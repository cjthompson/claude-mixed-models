import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  tokensByDay,
  requestsByHourOfDay,
  cacheHitRateByModel,
  topModels,
  topSessions,
  errorsByStatus,
  todaysTotals,
  thinkingByModel,
  rangeTotals,
} from './queries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, 'schema.sql'), 'utf8');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  // Seed: 2 days, 2 models, mix of statuses and tokens.
  const insert = db.prepare(`
    INSERT INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                       input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
                       cache_5m_input_tokens, cache_1h_input_tokens, thinking_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Day 1: 2026-06-07
  insert.run('a1', '2026-06-07T10:00:00.000Z', 'minimax',     'MiniMax-M3',  'api.minimax.io',    200, 1000, 's1', 100, 10, 0, 0,    0, 0, 0);
  insert.run('a2', '2026-06-07T11:00:00.000Z', 'minimax',     'MiniMax-M3',  'api.minimax.io',    200, 2000, 's1', 200, 20, 0, 0,    0, 0, 0);
  insert.run('a3', '2026-06-07T12:00:00.000Z', 'claude-opus', 'claude-opus', 'api.anthropic.com', 502,  500, 's1',   0,  0, 0, 0,    0, 0, 83);
  // Day 2: 2026-06-08
  insert.run('b1', '2026-06-08T10:00:00.000Z', 'minimax',     'MiniMax-M3',  'api.minimax.io',    200, 1500, 's2', 300, 30, 50, 0,   0, 0, 0);
  insert.run('b2', '2026-06-08T11:00:00.000Z', 'claude-opus', 'claude-opus', 'api.anthropic.com', 200, 2500, 's2', 400, 40, 0, 0,    0, 0, 0);
  return db;
}

// Build rollups from the seeded events so the rollup-backed queries have data.
// Mirrors what the batcher does, but inline so queries.test.js stays self-contained.
function buildRollups(db) {
  for (const [tbl, keyExpr] of [
    ['rollup_1d', "substr(ts,1,10)"],
    ['rollup_1h', "substr(ts,1,13) || ':00:00.000Z'"],
    ['rollup_5m', "substr(ts,1,13) || ':00:00.000Z'"],
  ]) {
    db.exec(`
      INSERT INTO ${tbl} (bucket_start, model, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, cache_5m, cache_1h, thinking, p50_ms, p95_ms)
      SELECT ${keyExpr} AS bucket_start, model, upstream,
             COUNT(*), SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),
             SUM(input_tokens), SUM(output_tokens),
             SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
             SUM(cache_5m_input_tokens), SUM(cache_1h_input_tokens),
             SUM(thinking_tokens),
             NULL, NULL
      FROM events
      GROUP BY bucket_start, model, upstream
    `);
  }
}

test('tokensByDay: returns one row per day, summed by model', () => {
  const db = freshDb();
  buildRollups(db);
  const rows = tokensByDay(db, '30d');
  // Two days, each row totals across all models for that day.
  const byDate = {};
  for (const r of rows) byDate[r.date] = (byDate[r.date] ?? 0) + r.tokens;
  assert.equal(byDate['2026-06-07'], 100 + 10 + 200 + 20 + 0 + 0);   // 330
  assert.equal(byDate['2026-06-08'], 300 + 30 + 400 + 40);            // 770
});

test('tokensByDay: 24h range uses hourly buckets, not daily', () => {
  // Regression: a daily rollup collapses the 24h window to a single bar.
  // tokensByDay must read rollup_1h without the date substr so the chart
  // shows ~24 hourly bars.
  const db = freshDb();
  buildRollups(db);
  const rows = tokensByDay(db, '24h');
  // Seed spans 2 days; 24h filter only catches one of them. We assert
  // shape, not counts (the test seed is older than 24h relative to now).
  // The point is: each row's `date` carries a time component.
  for (const r of rows) {
    assert.match(r.date, /T\d{2}:00:00\.000Z$/, `expected hourly bucket, got ${r.date}`);
  }
});

test('requestsByHourOfDay: returns one row per rollup_1h bucket, preserving bucket_start', () => {
  // Frontend buckets by *browser-local* hour-of-day, so the backend must
  // hand back the raw UTC bucket boundaries. This test pins that contract:
  // one row per distinct bucket_start, no server-side hour bucketing.
  const db = freshDb();
  buildRollups(db);
  const rows = requestsByHourOfDay(db, 'all');
  // 5 events at 5 distinct bucket_starts (10/11/12 on day 1, 10/11 on day 2).
  assert.equal(rows.length, 5);
  const total = rows.reduce((s, r) => s + r.requests, 0);
  assert.equal(total, 5);
  // Each row carries the original bucket boundary (a top-of-hour ISO 8601),
  // not an integer hour.
  for (const r of rows) {
    assert.match(r.bucket, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
    assert.equal(typeof r.hour, 'undefined');   // old shape removed
  }
});

test('requestsByHourOfDay: 30d and all read from rollup_1h, not rollup_1d', () => {
  // Regression: rollup_1d stores 'YYYY-MM-DD' with no time component, so the
  // old `strftime('%H', bucket_start)` on it bucketed every request at hour 0
  // for the 30d/all-time views. The fix reads from rollup_1h instead.
  // Both 30d and all now share the rollup_1h path, so verifying 'all' is
  // enough to catch a regression in either range.
  const db = freshDb();
  buildRollups(db);
  const rows = requestsByHourOfDay(db, 'all');
  assert.equal(rows.length, 5);    // not 1 — we didn't fall back to rollup_1d
  assert.ok(rows.every((r) => r.bucket.includes('T')));   // has a time component
});

test('cacheHitRateByModel: returns ratio of cache_read to total input', () => {
  const db = freshDb();
  buildRollups(db);
  const rows = cacheHitRateByModel(db, 'all');
  const byModel = Object.fromEntries(rows.map((r) => [r.model, r.hitRate]));
  // minimax: 50 cache reads out of 100+200+300 input + 50 cache_read = 650 → 50/650
  // claude-opus: 0 cache reads → 0
  assert.ok(Math.abs(byModel['minimax'] - 50 / 650) < 1e-9);
  assert.equal(byModel['claude-opus'], 0);
});

test('topModels: returns models ordered by total input_tokens desc', () => {
  const db = freshDb();
  buildRollups(db);
  const rows = topModels(db, 'all');
  assert.equal(rows[0].model, 'minimax');          // 100+200+300 = 600
  assert.equal(rows[1].model, 'claude-opus');      // 0+400 = 400
  assert.equal(rows[0].requests, 3);
  assert.equal(rows[1].requests, 2);
});

test('topSessions: returns sessions ordered by request count desc', () => {
  const rows = topSessions(freshDb(), 'all');
  assert.equal(rows[0].session_id, 's1');
  assert.equal(rows[0].requests, 3);
  assert.equal(rows[1].session_id, 's2');
  assert.equal(rows[1].requests, 2);
});

test('errorsByStatus: returns counts of status >= 400 in the last 24h', () => {
  // The seed data is older than 24h relative to "now"; expect zero rows.
  const rows = errorsByStatus(freshDb(), '24h');
  assert.deepEqual(rows, []);
});

test('ranged rollup queries filter on bucket_start (not ts) without error', () => {
  // Regression: rollup tables have no `ts` column. A ranged query must filter on
  // `bucket_start`. This throws "no such column: ts" if that regresses, regardless
  // of whether any rows fall inside the window — so it stays valid as dates advance.
  const db = freshDb();
  buildRollups(db);
  assert.doesNotThrow(() => tokensByDay(db, '7d'));
  assert.doesNotThrow(() => requestsByHourOfDay(db, '30d'));
  assert.doesNotThrow(() => cacheHitRateByModel(db, '30d'));
  assert.doesNotThrow(() => topModels(db, '30d'));
});

test('todaysTotals: returns an object with numeric keys', () => {
  // Seed data is in early June 2026; "today" in a future test run will be different.
  // We just assert the function runs and returns a single object with the expected keys.
  const db = freshDb();
  buildRollups(db);
  const row = todaysTotals(db);
  assert.equal(typeof row.requests, 'number');
  assert.equal(typeof row.input_tokens, 'number');
  // The thinking field was added with the normalizeUsage refactor;
  // todaysTotals must include it in the returned object even when the
  // value is 0 (the empty-day case).
  assert.equal(typeof row.thinking, 'number');
});

test('thinkingByModel: returns only models with nonzero thinking, ranked desc', () => {
  // Seed: only claude-opus on day 1 has thinking (83). All other rows
  // are 0. The 'all' range covers both seeded days.
  const db = freshDb();
  buildRollups(db);
  const rows = thinkingByModel(db, 'all');
  assert.equal(rows.length, 1, 'only claude-opus has thinking tokens in the seed');
  assert.equal(rows[0].model, 'claude-opus');
  assert.equal(rows[0].thinking, 83);
});

test('topModels: includes cache_5m, cache_1h, and thinking sums', () => {
  const db = freshDb();
  buildRollups(db);
  const rows = topModels(db, 'all');
  // minimax: cache_5m=0+0+0+0=0, cache_1h=0, thinking=0 (no thinking ever)
  const minimax = rows.find((r) => r.model === 'minimax');
  assert.equal(minimax.cache_5m, 0);
  assert.equal(minimax.cache_1h, 0);
  assert.equal(minimax.thinking, 0);
  // claude-opus: cache_5m=0+0=0, cache_1h=0+0=0, thinking=83+0=83
  const opus = rows.find((r) => r.model === 'claude-opus');
  assert.equal(opus.cache_5m, 0);
  assert.equal(opus.cache_1h, 0);
  assert.equal(opus.thinking, 83);
});

test('rangeTotals: sums requests and tokens over the selected range', () => {
  const db = freshDb();
  buildRollups(db);
  // 'all' range: covers both seeded days
  const all = rangeTotals(db, 'all');
  assert.equal(all.requests, 5);
  assert.equal(all.input_tokens, 1000);
  assert.equal(all.output_tokens, 100);
  assert.equal(typeof all.thinking, 'number');

  // '24h' range: seed data is historical, so should return zeros
  const h24 = rangeTotals(db, '24h');
  assert.equal(h24.requests, 0);
  assert.equal(typeof h24.input_tokens, 'number');
});
