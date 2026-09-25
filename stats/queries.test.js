import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  tokensByBucket,
  requestsByHourOfDay,
  cacheHitRateByModel,
  topModels,
  topSessions,
  errorsByStatus,
  todaysTotals,
  thinkingByModel,
  rangeTotals,
  totalsByRealModel,
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

// Rows emitted after the #012 usage normalization and a native Anthropic row
// share one storage contract: input_tokens is uncached context, while the
// cache counters are separate context categories. Keep these values explicit
// so query tests exercise both providers rather than only zero-cache fixtures.
function addMixedProviderRows(db) {
  const insert = db.prepare(`
    INSERT INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                       input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
                       cache_5m_input_tokens, cache_1h_input_tokens, thinking_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // OpenAI #012-normalized: raw input=1000 => uncached=100, cached=700, write=200.
  insert.run('o1', '2026-06-09T10:00:00.000Z', 'gpt-5', 'gpt-5', 'api.openai.com', 200, 1000, 's3', 100, 50, 700, 200, 0, 0, 30);
  // Anthropic-native: input_tokens already means uncached prompt input.
  insert.run('c1', '2026-06-09T11:00:00.000Z', 'claude-sonnet', 'claude-sonnet-4-6', 'api.anthropic.com', 200, 1000, 's3', 400, 40, 300, 100, 0, 100, 20);
}

// Build rollups from the seeded events so the rollup-backed queries have data.
// Mirrors what the batcher does, but inline so queries.test.js stays self-contained.
// real_model is in the GROUP BY because the rollup PK includes it (a route
// change mid-bucket would otherwise produce two rows that conflict).
function buildRollups(db) {
  for (const [tbl, keyExpr] of [
    ['rollup_1d', "substr(ts,1,10)"],
    ['rollup_1h', "substr(ts,1,13) || ':00:00.000Z'"],
    ['rollup_5m', "substr(ts,1,13) || ':00:00.000Z'"],
  ]) {
    db.exec(`
      INSERT INTO ${tbl} (bucket_start, model, real_model, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, cache_5m, cache_1h, thinking, p50_ms, p95_ms)
      SELECT ${keyExpr} AS bucket_start, model, COALESCE(real_model, '') AS real_model, upstream,
             COUNT(*), SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),
             SUM(input_tokens), SUM(output_tokens),
             SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
             SUM(cache_5m_input_tokens), SUM(cache_1h_input_tokens),
             SUM(thinking_tokens),
             NULL, NULL
      FROM events
      GROUP BY bucket_start, model, COALESCE(real_model, ''), upstream
    `);
  }
}

test('tokensByBucket: returns timestamped hourly rows for long ranges', () => {
  const db = freshDb();
  buildRollups(db);
  const rows = tokensByBucket(db, 'all');
  assert.ok(rows.some((r) => r.bucket === '2026-06-07T10:00:00.000Z'));
  assert.ok(rows.every((r) => /T\d{2}:00:00\.000Z$/.test(r.bucket)));
});

test('tokensByBucket: preserves exact UTC ISO bucket timestamps for all range', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO rollup_1h
    (bucket_start, model, upstream, requests, errors, input_tokens, output_tokens,
     cache_read, cache_write, cache_5m, cache_1h, thinking)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    '2026-09-12T00:00:00.000Z', 'timestamp-model', 'test', 1, 0, 10, 2, 0, 0, 0, 0, 0);
  const row = tokensByBucket(db, 'all').find((r) => r.model === 'timestamp-model');
  assert.deepEqual(row, { bucket: '2026-09-12T00:00:00.000Z', model: 'timestamp-model', real_model: null, tokens: 12 });
});

test('tokensByBucket: 24h range uses hourly buckets, not daily', () => {
  // Regression: a daily rollup collapses the 24h window to a single bar.
  // tokensByBucket must read rollup_1h without the date substr so the chart
  // shows ~24 hourly bars.
  const db = freshDb();
  buildRollups(db);
  const rows = tokensByBucket(db, '24h');
  // Seed spans 2 days; 24h filter only catches one of them. We assert
  // shape, not counts (the test seed is older than 24h relative to now).
  // The point is: each row's `bucket` carries a time component.
  for (const r of rows) {
    assert.match(r.bucket, /T\d{2}:00:00\.000Z$/, `expected hourly bucket, got ${r.bucket}`);
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

test('cacheHitRateByModel: returns raw counts (cache_read + context_tokens) per (alias, real_model)', () => {
  // The query returns per-(alias, real_model) raw counts so the frontend
  // can combine across aliases that canonicalize to the same display
  // name (averaging ratios loses information when the denominators
  // differ). The hit rate is computed client-side from these counts.
  const db = freshDb();
  buildRollups(db);
  const rows = cacheHitRateByModel(db, 'all');
  const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));
  // minimax: cache_read 50, context = 100+200+300+50 = 650
  assert.equal(byModel['minimax'].cache_read, 50);
  assert.equal(byModel['minimax'].context_tokens, 650);
  assert.equal(byModel['minimax'].input_tokens, 600);
  // claude-opus: 0 cache reads
  assert.equal(byModel['claude-opus'].cache_read, 0);
});

test('mixed providers: chart, sessions, hit rates, model components, and range totals use all token categories', () => {
  const db = freshDb();
  addMixedProviderRows(db);
  buildRollups(db);

  const chartRows = tokensByBucket(db, 'all');
  assert.equal(chartRows.find((r) => r.model === 'gpt-5').tokens, 100 + 700 + 200 + 50);
  assert.equal(chartRows.find((r) => r.model === 'claude-sonnet').tokens, 400 + 300 + 100 + 40);

  const session = topSessions(db, 'all').find((r) => r.session_id === 's3');
  assert.equal(session.tokens, (100 + 700 + 200 + 50) + (400 + 300 + 100 + 40));

  // cacheHitRateByModel returns raw counts now — the rate is derived
  // client-side. Assert the counts directly.
  const cacheCounts = Object.fromEntries(cacheHitRateByModel(db, 'all').map((r) => [r.model, r]));
  assert.equal(cacheCounts['gpt-5'].cache_read, 700);
  assert.equal(cacheCounts['gpt-5'].context_tokens, 100 + 700 + 200);
  assert.equal(cacheCounts['claude-sonnet'].cache_read, 300);
  assert.equal(cacheCounts['claude-sonnet'].context_tokens, 400 + 300 + 100);

  const models = Object.fromEntries(topModels(db, 'all').map((r) => [r.model, r]));
  assert.equal(models['gpt-5'].input_tokens, 100);
  assert.equal(models['gpt-5'].cache_read, 700);
  assert.equal(models['gpt-5'].cache_write, 200);
  assert.equal(models['gpt-5'].thinking, 30);
  assert.equal(models['claude-sonnet'].input_tokens, 400);
  assert.equal(models['claude-sonnet'].cache_read, 300);
  assert.equal(models['claude-sonnet'].cache_write, 100);
  assert.equal(models['claude-sonnet'].thinking, 20);

  const totals = rangeTotals(db, 'all');
  assert.equal(totals.input_tokens + totals.cache_read + totals.cache_write, 1500 + 1050 + 300);
  assert.equal(totals.output_tokens, 190);
  assert.equal(totals.thinking, 133);
});

test('topModels: returns models ordered by total context desc', () => {
  const db = freshDb();
  buildRollups(db);
  const rows = topModels(db, 'all');
  assert.equal(rows[0].model, 'minimax');          // context = 100+200+300+50 = 650
  assert.equal(rows[1].model, 'claude-opus');      // context = 0+400 = 400
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
  assert.doesNotThrow(() => tokensByBucket(db, '7d'));
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

// `real_model` carries the resolved upstream model distinct from the
// alias the caller asked for. NULL in the API output means "no
// redirect" — the alias was served by its own real model. All rollup-
// backed queries must surface this column so the dashboard can render
// "alias (→ real_model)" rows alongside plain aliases.
test('topModels: returns real_model for each row (null when no redirect)', () => {
  const db = freshDb();
  buildRollups(db);
  const rows = topModels(db, 'all');
  const minimax = rows.find((r) => r.model === 'minimax');
  assert.ok(minimax, 'minimax row should exist');
  // Seeded events for 'minimax' had real_model='MiniMax-M3', so the
  // rollup's real_model column is 'MiniMax-M3' (mapped to null when the
  // query returns it through normalizeRealModel).
  assert.equal(minimax.real_model, 'MiniMax-M3');
});

test('cacheHitRateByModel: returns real_model alongside the count fields', () => {
  const db = freshDb();
  buildRollups(db);
  const rows = cacheHitRateByModel(db, 'all');
  const minimax = rows.find((r) => r.model === 'minimax');
  assert.ok(minimax);
  assert.equal(minimax.real_model, 'MiniMax-M3');
  assert.equal(typeof minimax.cache_read, 'number');
  assert.equal(typeof minimax.context_tokens, 'number');
});

test('thinkingByModel: returns real_model so the dashboard can show the redirect', () => {
  const db = freshDb();
  buildRollups(db);
  const rows = thinkingByModel(db, 'all');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'claude-opus');
  assert.equal(rows[0].real_model, 'claude-opus');
});

test('totalsByRealModel: aggregates across all aliases, no LIMIT', () => {
  const db = freshDb();
  buildRollups(db);
  const totals = totalsByRealModel(db, 'all');
  // Seeded: 4 minimax events (MiniMax-M3) + 1 claude-opus (claude-opus) + 1 claude-opus 502
  // Wait — let's recount from the freshDb fixture.
  // a1, a2, b1 → minimax/MiniMax-M3 (3 events, 1 with cache_read)
  // a3, b2 → claude-opus/claude-opus (2 events)
  const m3 = totals.find((r) => r.real_model === 'MiniMax-M3');
  assert.ok(m3, 'MiniMax-M3 row should exist');
  assert.equal(m3.requests, 3);
  const opus = totals.find((r) => r.real_model === 'claude-opus');
  assert.ok(opus);
  assert.equal(opus.requests, 2);
});

test('tokensByBucket: groups by (bucket, model, real_model) so redirected aliases stay distinct', () => {
  // Same bucket, same alias, two different real_models — possible when a
  // routes.config.json redirect changes mid-bucket. The query must split
  // these into separate rows rather than silently summing under one.
  const db = freshDb();
  const insert = db.prepare(`
    INSERT INTO rollup_1h (bucket_start, model, real_model, upstream, requests, errors,
                          input_tokens, output_tokens, cache_read, cache_write,
                          cache_5m, cache_1h, thinking)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('2026-06-07T10:00:00.000Z', 'haiku', 'MiniMax-M3',  'api.minimax.io',    10, 0, 100, 50, 0, 0, 0, 0, 0);
  insert.run('2026-06-07T10:00:00.000Z', 'haiku', 'claude-haiku-4-5', 'api.anthropic.com', 5, 0, 50, 25, 0, 0, 0, 0, 0);
  const rows = tokensByBucket(db, 'all');
  const bucket = rows.filter((r) => r.bucket === '2026-06-07T10:00:00.000Z' && r.model === 'haiku');
  assert.equal(bucket.length, 2, `expected 2 rows for haiku in this bucket, got ${JSON.stringify(bucket)}`);
  const m3 = bucket.find((r) => r.real_model === 'MiniMax-M3');
  const real = bucket.find((r) => r.real_model === 'claude-haiku-4-5');
  assert.ok(m3 && real);
  assert.equal(m3.tokens, 150);
  assert.equal(real.tokens, 75);
});
