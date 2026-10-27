import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// We import the batcher's runOnce() so we can drive a single pass without spawning a process.
import { runOnce, installShutdown, isDataError } from './batcher.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, '..', 'schema.sql');

// Clears LOG_LEVEL/DEBUG for the duration of a test and returns a restore fn
// that puts back the prior values (delete only if originally unset).
function isolateLogEnv() {
  const saved = { LOG_LEVEL: process.env.LOG_LEVEL, DEBUG: process.env.DEBUG };
  delete process.env.LOG_LEVEL;
  delete process.env.DEBUG;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

function freshPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'batcher-test-'));
  return {
    dir,
    jsonlPath: join(dir, 'events.jsonl'),
    dbPath:   join(dir, 'stats.db'),
    cleanup:  () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('runOnce: reads all lines from JSONL, inserts into events, truncates file', async () => {
  const { jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    fs.writeFileSync(jsonlPath, [
      JSON.stringify({ id: 'a', ts: '2026-06-08T10:00:00.000Z', model: 'minimax', real_model: 'MiniMax-M3', upstream: 'api.minimax.io', status: 200, durationMs: 1000, sessionId: 's1', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      JSON.stringify({ id: 'b', ts: '2026-06-08T10:01:00.000Z', model: 'minimax', real_model: 'MiniMax-M3', upstream: 'api.minimax.io', status: 200, durationMs: 2000, sessionId: 's1', input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ].join('\n') + '\n');

    await runOnce({ jsonlPath, dbPath });

    const db = new DatabaseSync(dbPath);
    const events = db.prepare('SELECT id, input_tokens FROM events ORDER BY id').all();
    assert.equal(events.length, 2);
    assert.equal(events[0].input_tokens, 100);
    assert.equal(events[1].input_tokens, 200);

    const rollup = db.prepare(`SELECT requests, input_tokens FROM rollup_5m WHERE model='minimax'`).get();
    assert.equal(rollup.requests, 2);
    assert.equal(rollup.input_tokens, 300);
    db.close();

    // JSONL must be truncated.
    const after = fs.readFileSync(jsonlPath, 'utf8');
    assert.equal(after, '');
  } finally {
    cleanup();
  }
});

test('runOnce: retried line (same id+ts) is deduped by INSERT OR IGNORE', async () => {
  const { jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    const rec = { id: 'dup', ts: '2026-06-08T10:00:00.000Z', model: 'minimax', real_model: 'MiniMax-M3', upstream: 'api.minimax.io', status: 200, durationMs: 1000, sessionId: 's1', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    fs.writeFileSync(jsonlPath, JSON.stringify(rec) + '\n');
    await runOnce({ jsonlPath, dbPath });
    // JSONL is truncated; re-add the same line and run again.
    fs.writeFileSync(jsonlPath, JSON.stringify(rec) + '\n');
    await runOnce({ jsonlPath, dbPath });

    const db = new DatabaseSync(dbPath);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE id='dup'`).get().c;
    assert.equal(count, 1);

    // Rollup must not double-count.
    const rollup = db.prepare(`SELECT requests FROM rollup_5m WHERE model='minimax'`).get();
    assert.equal(rollup.requests, 1);
    db.close();
  } finally {
    cleanup();
  }
});

test('runOnce: skips malformed lines and continues', async () => {
  const { jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    fs.writeFileSync(jsonlPath, [
      'not json at all',
      JSON.stringify({ id: 'good', ts: '2026-06-08T10:00:00.000Z', model: 'minimax', real_model: 'MiniMax-M3', upstream: 'api.minimax.io', status: 200, durationMs: 1000, sessionId: 's1', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ].join('\n') + '\n');

    await runOnce({ jsonlPath, dbPath });

    const db = new DatabaseSync(dbPath);
    const events = db.prepare('SELECT id FROM events').all();
    assert.equal(events.length, 1);
    assert.equal(events[0].id, 'good');
    db.close();
  } finally {
    cleanup();
  }
});

const goodEvent = (id, extra = {}) => JSON.stringify({ id, ts: '2026-06-08T10:00:00.000Z', model: 'minimax', real_model: 'MiniMax-M3', upstream: 'api.minimax.io', status: 200, durationMs: 1000, sessionId: 's1', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...extra });
const readJsonl = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('runOnce: model-less events are moved to the rejected file, not allowed to block the batch', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  const rejectedPath = join(dir, 'events.other.jsonl');
  try {
    fs.writeFileSync(jsonlPath, [
      JSON.stringify({ id: 'nomodel', ts: '2026-06-08T10:00:00.000Z', real_model: null, upstream: 'api.anthropic.com', status: 401, durationMs: 73 }),
      goodEvent('good1'),
      JSON.stringify({ id: 'nullmod', model: null, ts: '2026-06-08T10:00:01.000Z', upstream: 'chatgpt.com', status: 200, durationMs: 400 }),
      goodEvent('good2', { ts: '2026-06-08T10:01:00.000Z' }),
    ].join('\n') + '\n');

    const result = await runOnce({ jsonlPath, dbPath, rejectedPath });

    assert.equal(result.inserted, 2);
    assert.equal(result.rejected, 2);
    const db = new DatabaseSync(dbPath);
    assert.deepEqual(db.prepare('SELECT id FROM events ORDER BY id').all().map((r) => r.id), ['good1', 'good2']);
    db.close();
    assert.equal(readFileSync(jsonlPath, 'utf8'), '', 'main file is truncated');
    const rejected = readJsonl(rejectedPath);
    assert.deepEqual(rejected.map((r) => r.id), ['nomodel', 'nullmod']);
    assert.match(rejected[0].rejectReason, /model/);
  } finally {
    cleanup();
  }
});

test('runOnce: unparseable lines are preserved in the rejected file as rawLine', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  const rejectedPath = join(dir, 'events.other.jsonl');
  try {
    fs.writeFileSync(jsonlPath, ['not json at all', goodEvent('good')].join('\n') + '\n');
    const result = await runOnce({ jsonlPath, dbPath, rejectedPath });
    assert.equal(result.inserted, 1);
    assert.equal(result.rejected, 1);
    const [rec] = readJsonl(rejectedPath);
    assert.equal(rec.rawLine, 'not json at all');
    assert.match(rec.rejectReason, /JSON/i);
  } finally {
    cleanup();
  }
});

test('runOnce: an event whose insert throws for another reason is rejected, not fatal', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  const rejectedPath = join(dir, 'events.other.jsonl');
  try {
    // status omitted -> undefined bind -> node:sqlite throws.
    const noStatus = JSON.parse(goodEvent('nostatus'));
    delete noStatus.status;
    fs.writeFileSync(jsonlPath, [JSON.stringify(noStatus), goodEvent('good')].join('\n') + '\n');
    const result = await runOnce({ jsonlPath, dbPath, rejectedPath });
    assert.equal(result.inserted, 1);
    assert.equal(result.rejected, 1);
    const [rec] = readJsonl(rejectedPath);
    assert.equal(rec.id, 'nostatus');
    assert.match(rec.rejectReason, /bound|status/i);
    assert.equal(readFileSync(jsonlPath, 'utf8'), '');
  } finally {
    cleanup();
  }
});

test('runOnce: no rejected file is created when every line is valid', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  const rejectedPath = join(dir, 'events.other.jsonl');
  try {
    fs.writeFileSync(jsonlPath, goodEvent('good') + '\n');
    const result = await runOnce({ jsonlPath, dbPath, rejectedPath });
    assert.equal(result.rejected, 0);
    assert.ok(!fs.existsSync(rejectedPath));
  } finally {
    cleanup();
  }
});

test('runOnce: if the rejected file cannot be written, the main file is kept for retry', async () => {
  const { jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    const content = [JSON.stringify({ id: 'nomodel', ts: '2026-06-08T10:00:00.000Z', upstream: 'x', status: 200, durationMs: 1 }), goodEvent('good')].join('\n') + '\n';
    fs.writeFileSync(jsonlPath, content);
    await assert.rejects(runOnce({ jsonlPath, dbPath, rejectedPath: '/dev/null/nope/other.jsonl' }));
    assert.equal(readFileSync(jsonlPath, 'utf8'), content, 'nothing is lost when the reject sink fails');
  } finally {
    cleanup();
  }
});

test('isDataError: only record-attributable failures count as data errors', () => {
  const sqlite = (errcode) => Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errcode });
  const bind = Object.assign(new TypeError('Provided value cannot be bound to SQLite parameter 3.'), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(isDataError(bind), true, 'bind TypeError');
  assert.equal(isDataError(sqlite(1299)), true, 'NOT NULL');
  assert.equal(isDataError(sqlite(275)), true, 'CHECK');
  for (const [name, code] of [['generic SQL error (schema mismatch)', 1], ['busy', 5], ['locked', 6], ['readonly', 8], ['I/O error', 10], ['disk full', 13], ['cannot open', 14], ['trigger abort', 1811]]) {
    assert.equal(isDataError(sqlite(code)), false, name);
  }
  assert.equal(isDataError(new Error('plain')), false);
  assert.equal(isDataError(null), false);
});

test('runOnce: a NOT NULL violation on another column is a data error and is rejected', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  const rejectedPath = join(dir, 'events.other.jsonl');
  try {
    fs.writeFileSync(jsonlPath, [goodEvent('nullts', { ts: null }), goodEvent('good')].join('\n') + '\n');
    const result = await runOnce({ jsonlPath, dbPath, rejectedPath });
    assert.equal(result.inserted, 1);
    assert.equal(result.rejected, 1);
    assert.match(readJsonl(rejectedPath)[0].rejectReason, /NOT NULL/);
  } finally {
    cleanup();
  }
});

test('runOnce: a non-data insert failure aborts the pass and keeps the file for automatic retry', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  const rejectedPath = join(dir, 'events.other.jsonl');
  try {
    await runOnce({ jsonlPath, dbPath, rejectedPath });   // create + migrate the DB
    const db = new DatabaseSync(dbPath);
    // RAISE(ABORT) surfaces as errcode 1811 (constraint trigger): a stand-in for any non-data fault.
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'simulated infra fault'); END`);
    db.close();

    const content = [goodEvent('a'), goodEvent('b', { ts: '2026-06-08T10:01:00.000Z' })].join('\n') + '\n';
    fs.writeFileSync(jsonlPath, content);
    await assert.rejects(runOnce({ jsonlPath, dbPath, rejectedPath }), /simulated infra fault/);

    assert.equal(readFileSync(jsonlPath, 'utf8'), content, 'file kept so the next pass retries');
    assert.ok(!fs.existsSync(rejectedPath), 'good data must not be diverted');

    const check = new DatabaseSync(dbPath);
    check.exec('DROP TRIGGER boom');
    check.close();
    const result = await runOnce({ jsonlPath, dbPath, rejectedPath });   // fault cleared -> automatic recovery
    assert.equal(result.inserted, 2);
    assert.equal(result.rejected, 0);
  } finally {
    cleanup();
  }
});

test('runOnce: circuit breaker - every line that reaches the DB failing aborts instead of diverting', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  const rejectedPath = join(dir, 'events.other.jsonl');
  try {
    const bad = Array.from({ length: 5 }, (_, i) => goodEvent(`bad${i}`, { ts: null }));
    const content = bad.join('\n') + '\n';
    fs.writeFileSync(jsonlPath, content);
    await assert.rejects(runOnce({ jsonlPath, dbPath, rejectedPath }), /circuit breaker/i);
    assert.equal(readFileSync(jsonlPath, 'utf8'), content);
    assert.ok(!fs.existsSync(rejectedPath));
  } finally {
    cleanup();
  }
});

test('runOnce: circuit breaker does not trip when some lines insert, or below the threshold', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  const rejectedPath = join(dir, 'events.other.jsonl');
  try {
    const bad = (n) => Array.from({ length: n }, (_, i) => goodEvent(`bad${i}`, { ts: null }));
    fs.writeFileSync(jsonlPath, [...bad(5), goodEvent('good')].join('\n') + '\n');
    const mixed = await runOnce({ jsonlPath, dbPath, rejectedPath });
    assert.deepEqual([mixed.inserted, mixed.rejected], [1, 5]);

    fs.writeFileSync(jsonlPath, bad(4).join('\n') + '\n');
    const few = await runOnce({ jsonlPath, dbPath, rejectedPath });
    assert.deepEqual([few.inserted, few.rejected], [0, 4]);
  } finally {
    cleanup();
  }
});

test('runOnce: circuit breaker ignores model-less lines, which are known non-chat traffic', async () => {
  const { dir, jsonlPath, dbPath, cleanup } = freshPaths();
  const rejectedPath = join(dir, 'events.other.jsonl');
  try {
    const modelless = Array.from({ length: 8 }, (_, i) => JSON.stringify({ id: `m${i}`, ts: '2026-06-08T10:00:00.000Z', upstream: 'chatgpt.com', status: 200, durationMs: 1 }));
    fs.writeFileSync(jsonlPath, modelless.join('\n') + '\n');
    const result = await runOnce({ jsonlPath, dbPath, rejectedPath });
    assert.deepEqual([result.inserted, result.rejected], [0, 8]);
  } finally {
    cleanup();
  }
});

// New fields added with the normalizeUsage refactor: cache TTL split
// (cache_5m / cache_1h) and thinking_tokens. The router writes these
// from the flattened Anthropic usage shape; the batcher must persist
// them and aggregate them on the rollup so the dashboard can attribute
// them per model.
test('runOnce: persists cache_5m/1h and thinking tokens, aggregates them on the rollup', async () => {
  const { jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    // Opus thinking turn + Sonnet non-thinking turn + Haiku 5m-only turn.
    // The cache_write sum equals cache_5m + cache_1h for each row.
    fs.writeFileSync(jsonlPath, [
      JSON.stringify({ id: 'opus',  ts: '2026-06-08T10:00:00.000Z', model: 'opus',  real_model: 'claude-opus-4-8',     upstream: 'api.anthropic.com', status: 200, durationMs: 1000, sessionId: 's1', input_tokens: 2,    output_tokens: 1041, cache_read_input_tokens: 0,    cache_creation_input_tokens: 267014, cache_5m_input_tokens: 0,       cache_1h_input_tokens: 267014, thinking_tokens: 83 }),
      JSON.stringify({ id: 'sonnet',ts: '2026-06-08T10:00:00.000Z', model: 'sonnet',real_model: 'claude-sonnet-4-6',   upstream: 'api.anthropic.com', status: 200, durationMs: 1000, sessionId: 's1', input_tokens: 1,    output_tokens: 93,   cache_read_input_tokens: 92488, cache_creation_input_tokens: 266,    cache_5m_input_tokens: 0,       cache_1h_input_tokens: 266,     thinking_tokens: 0 }),
      JSON.stringify({ id: 'haiku', ts: '2026-06-08T10:00:00.000Z', model: 'haiku', real_model: 'claude-haiku-4-5',     upstream: 'api.anthropic.com', status: 200, durationMs: 1000, sessionId: 's1', input_tokens: 3,    output_tokens: 372,  cache_read_input_tokens: 0,     cache_creation_input_tokens: 17866,  cache_5m_input_tokens: 17866,   cache_1h_input_tokens: 0,        thinking_tokens: 0 }),
    ].join('\n') + '\n');

    await runOnce({ jsonlPath, dbPath });

    const db = new DatabaseSync(dbPath);

    // Per-row assertions: TTL split and thinking tokens round-trip.
    const opus = db.prepare(`SELECT cache_5m_input_tokens, cache_1h_input_tokens, thinking_tokens FROM events WHERE id='opus'`).get();
    assert.equal(opus.cache_5m_input_tokens, 0);
    assert.equal(opus.cache_1h_input_tokens, 267014);
    assert.equal(opus.thinking_tokens, 83);
    const haiku = db.prepare(`SELECT cache_5m_input_tokens, cache_1h_input_tokens, thinking_tokens FROM events WHERE id='haiku'`).get();
    assert.equal(haiku.cache_5m_input_tokens, 17866);
    assert.equal(haiku.cache_1h_input_tokens, 0);
    assert.equal(haiku.thinking_tokens, 0);

    // Per-model rollup: each model is in its own bucket (5m) but the
    // three rows share a bucket, so per-model rolls are clean.
    const opusRollup = db.prepare(`SELECT cache_5m, cache_1h, thinking FROM rollup_5m WHERE model='opus'`).get();
    assert.equal(opusRollup.cache_5m, 0);
    assert.equal(opusRollup.cache_1h, 267014);
    assert.equal(opusRollup.thinking, 83);
    const haikuRollup = db.prepare(`SELECT cache_5m, cache_1h, thinking FROM rollup_5m WHERE model='haiku'`).get();
    assert.equal(haikuRollup.cache_5m, 17866);
    assert.equal(haikuRollup.cache_1h, 0);
    assert.equal(haikuRollup.thinking, 0);

    db.close();
  } finally {
    cleanup();
  }
});

// Idempotency: a pre-existing DB without the new columns must come up
// to date via applyMigrations() without losing data, and a second pass
// must not error trying to re-add the columns.
test('runOnce: applyMigrations adds new columns to a pre-existing DB and is idempotent on re-run', async () => {
  const { jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    // First pass: schema is fresh, applyMigrations runs but does nothing
    // because the columns are already there from CREATE TABLE.
    fs.writeFileSync(jsonlPath, JSON.stringify({ id: 'a', ts: '2026-06-08T10:00:00.000Z', model: 'm', real_model: 'M', upstream: 'u', status: 200, durationMs: 1, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_5m_input_tokens: 0, cache_1h_input_tokens: 0, thinking_tokens: 0 }) + '\n');
    await runOnce({ jsonlPath, dbPath });

    // Manually drop the new columns to simulate a DB from before the
    // migration. SQLite has no DROP COLUMN ... IF EXISTS, so we recreate
    // the tables with the older shape. (The realistic version of this
    // scenario is an existing user upgrading; the test exercises the
    // "ALTER TABLE must be idempotent" path without us having to ship a
    // real downgrade.)
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE events_old AS SELECT id, ts, model, real_model, upstream, status, duration_ms, session_id,
                                       input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
                                FROM events;
      DROP TABLE events;
      ALTER TABLE events_old RENAME TO events;
    `);
    // Also strip the rollup columns so applyMigrations has work to do.
    db.exec(`
      CREATE TABLE rollup_5m_old AS SELECT bucket_start, model, upstream, requests, errors, input_tokens, output_tokens, cache_read, cache_write, p50_ms, p95_ms FROM rollup_5m;
      DROP TABLE rollup_5m;
      ALTER TABLE rollup_5m_old RENAME TO rollup_5m;
    `);
    db.close();

    // Second pass with empty JSONL — applyMigrations should run ALTER
    // TABLE for the dropped columns. Empty JSONL means runOnce exits
    // early before INSERT, so we're really testing the migration path.
    fs.writeFileSync(jsonlPath, '');
    await runOnce({ jsonlPath, dbPath });

    const db2 = new DatabaseSync(dbPath);
    const cols = db2.prepare(`PRAGMA table_info(events)`).all().map((c) => c.name);
    assert.ok(cols.includes('cache_5m_input_tokens'), `cache_5m_input_tokens should be present, got: ${cols.join(',')}`);
    assert.ok(cols.includes('cache_1h_input_tokens'), 'cache_1h_input_tokens should be present');
    assert.ok(cols.includes('thinking_tokens'), 'thinking_tokens should be present');
    const rollupCols = db2.prepare(`PRAGMA table_info(rollup_5m)`).all().map((c) => c.name);
    assert.ok(rollupCols.includes('cache_5m'), 'rollup_5m.cache_5m should be present');
    assert.ok(rollupCols.includes('cache_1h'), 'rollup_5m.cache_1h should be present');
    assert.ok(rollupCols.includes('thinking'), 'rollup_5m.thinking should be present');
    db2.close();

    // Third pass: rerun on the now-migrated DB. applyMigrations must be
    // a no-op (no error from "duplicate column name").
    await runOnce({ jsonlPath, dbPath });
  } finally {
    cleanup();
  }
});

// The CREATE TABLE AS SELECT above happens to inherit an implicit
// nullable column from the source SELECT, which means it doesn't
// exercise the DROP NOT NULL branch. Build a fresh DB whose events
// table has real_model NOT NULL (matching the pre-real_model-aware
// schema) and verify applyMigrations drops the constraint so events
// with null real_model — the no-redirect case the router now emits —
// can be inserted.
test('runOnce: applyMigrations drops NOT NULL on events.real_model so no-redirect events can be inserted', async () => {
  const { jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    // Build a DB by hand whose events.real_model is NOT NULL — the
    // shape a user would have had before the real_model-aware router
    // was deployed. INSERT a row that satisfies the existing NOT NULL
    // so we have a real (older-schema) DB on disk to migrate from.
    const seed = new DatabaseSync(dbPath);
    seed.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    // Recreate events with real_model TEXT NOT NULL (the pre-fix schema).
    seed.exec(`
      CREATE TABLE events_v0 (
        id TEXT NOT NULL, ts TEXT NOT NULL, model TEXT NOT NULL,
        real_model TEXT NOT NULL,
        upstream TEXT NOT NULL, status INTEGER NOT NULL, duration_ms INTEGER NOT NULL, session_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_5m_input_tokens INTEGER NOT NULL DEFAULT 0, cache_1h_input_tokens INTEGER NOT NULL DEFAULT 0,
        thinking_tokens INTEGER NOT NULL DEFAULT 0, effort TEXT,
        PRIMARY KEY (id, ts)
      );
      DROP TABLE events;
      ALTER TABLE events_v0 RENAME TO events;
    `);
    // Real_model is now NOT NULL on events; recreate rollups with the
    // old PK (no real_model) so dropStaleRollups has work to do too.
    for (const grain of ['5m', '1h', '1d']) {
      seed.exec(`DROP TABLE rollup_${grain}`);
    }
    seed.close();

    // Write a JSONL event whose real_model is null — the new contract
    // for no-redirect traffic. The pre-fix schema would reject this
    // with "NOT NULL constraint failed"; applyMigrations must have
    // dropped the constraint before INSERT runs.
    fs.writeFileSync(jsonlPath, JSON.stringify({
      id: 'no-redirect-v0', ts: '2026-06-08T10:00:00.000Z',
      model: 'claude-haiku-4-5', real_model: null,
      upstream: 'api.minimax.io', status: 200, durationMs: 5,
      input_tokens: 10, output_tokens: 42,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_5m_input_tokens: 0, cache_1h_input_tokens: 0, thinking_tokens: 0,
    }) + '\n');

    const result = await runOnce({ jsonlPath, dbPath });
    assert.equal(result.inserted, 1, 'runOnce must accept null real_model on events');

    const db = new DatabaseSync(dbPath);
    const event = db.prepare(`SELECT real_model FROM events WHERE id='no-redirect-v0'`).get();
    assert.equal(event.real_model, null, 'events.real_model must remain null after insert');
    const cols = db.prepare(`PRAGMA table_info(events)`).all();
    const realModelCol = cols.find((c) => c.name === 'real_model');
    assert.equal(realModelCol.notnull, 0, 'events.real_model NOT NULL must have been dropped');

    // Backfill: every event whose real_model equaled model under the old
    // contract (real_model = model for passthrough) is rewritten to NULL.
    db.prepare(`INSERT INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                                     input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
                                     cache_5m_input_tokens, cache_1h_input_tokens, thinking_tokens)
                VALUES ('old-passthrough', '2026-06-08T11:00:00.000Z', 'claude-opus-4-8', 'claude-opus-4-8',
                        'api.anthropic.com', 200, 5, null, 0, 0, 0, 0, 0, 0, 0)`).run();
    fs.writeFileSync(jsonlPath, '');
    await runOnce({ jsonlPath, dbPath });
    const rewritten = db.prepare(`SELECT real_model FROM events WHERE id='old-passthrough'`).get();
    assert.equal(rewritten.real_model, null, 'old-style passthrough events must be rewritten to NULL by the backfill');
    db.close();
  } finally {
    cleanup();
  }
});

// When a user upgrades from a pre-real_model PK on the rollup tables,
// applyMigrations must drop and recreate them with the new PK (which
// now includes real_model) so events split across real_models get
// separate rollup rows. The OLD data on those tables is rebuilt from
// events by fullRefreshGrain on the next startup — we don't need to
// preserve rollup rows across this migration.
test('runOnce: applyMigrations drops pre-real_model rollup tables so the new PK (with real_model) can take over', async () => {
  const { jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    // First pass: write one event so the rollup tables are created
    // with the current schema (PK includes real_model).
    fs.writeFileSync(jsonlPath, JSON.stringify({
      id: 'a', ts: '2026-06-08T10:00:00.000Z',
      model: 'claude-haiku-4-5', real_model: 'MiniMax-M3',
      upstream: 'api.minimax.io', status: 200, durationMs: 1,
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_5m_input_tokens: 0, cache_1h_input_tokens: 0, thinking_tokens: 0,
    }) + '\n');
    await runOnce({ jsonlPath, dbPath });

    // Recreate rollup_5m with the OLD PK (no real_model) to simulate an
    // upgrade from the pre-real_model schema. applyMigrations should
    // detect the missing real_model in the PK and drop the table.
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE rollup_5m_old AS SELECT bucket_start, model, real_model, upstream, requests, errors,
                                       input_tokens, output_tokens, cache_read, cache_write,
                                       cache_5m, cache_1h, thinking, p50_ms, p95_ms
                                FROM rollup_5m;
      DROP TABLE rollup_5m;
      ALTER TABLE rollup_5m_old RENAME TO rollup_5m;
    `);
    db.close();

    // Second pass — applyMigrations should drop rollup_5m because its
    // PK doesn't include real_model, then schema CREATE recreates it
    // with the new PK.
    fs.writeFileSync(jsonlPath, '');
    await runOnce({ jsonlPath, dbPath });

    const db2 = new DatabaseSync(dbPath);
    const pk = db2.prepare(`SELECT name FROM pragma_table_info('rollup_5m') WHERE pk > 0 ORDER BY pk`).all().map((r) => r.name);
    assert.ok(pk.includes('real_model'), `rollup_5m PK should include real_model after migration, got: ${JSON.stringify(pk)}`);
    db2.close();
  } finally {
    cleanup();
  }
});

// Companion to the previous test: dropStaleRollups clears rollup_refresh for
// the dropped table. Without this, refreshTick on the next startup compares
// against the pre-drop last_refresh and skips the grain — leaving the freshly
// recreated (empty) rollup table unpopulated. 1h/1d only refresh every 60 min
// / 24 h, so a missed refresh on the post-migration startup leaves the
// dashboard's 24h / 7d / 30d / all-time views empty until the next time the
// refresh interval happens to elapse. Dropping the matching rollup_refresh
// entry forces the next refreshTick to see age = Infinity and repopulate
// the table from events.
test('runOnce: dropStaleRollups clears the matching rollup_refresh entry so the post-migration refresh fires', async () => {
  const { jsonlPath, dbPath, cleanup } = freshPaths();
  try {
    // Seed the rollup tables and rollup_refresh as if a previous-version
    // batcher had run: rollup_5m has rows, rollup_refresh has entries.
    fs.writeFileSync(jsonlPath, JSON.stringify({
      id: 'a', ts: '2026-06-08T10:00:00.000Z',
      model: 'claude-haiku-4-5', real_model: 'MiniMax-M3',
      upstream: 'api.minimax.io', status: 200, durationMs: 1,
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_5m_input_tokens: 0, cache_1h_input_tokens: 0, thinking_tokens: 0,
    }) + '\n');
    await runOnce({ jsonlPath, dbPath });

    // Simulate the upgrade: recreate rollup_5m with the OLD PK and seed
    // rollup_refresh for both 5m and 1h with timestamps that would normally
    // make refreshTick skip them.
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE rollup_5m_old AS SELECT bucket_start, model, real_model, upstream, requests, errors,
                                       input_tokens, output_tokens, cache_read, cache_write,
                                       cache_5m, cache_1h, thinking, p50_ms, p95_ms
                                FROM rollup_5m;
      DROP TABLE rollup_5m;
      ALTER TABLE rollup_5m_old RENAME TO rollup_5m;
    `);
    db.prepare('INSERT OR REPLACE INTO rollup_refresh (grain, last_refresh) VALUES (?, ?)')
      .run('5m', new Date(Date.now() - 60_000).toISOString());
    db.prepare('INSERT OR REPLACE INTO rollup_refresh (grain, last_refresh) VALUES (?, ?)')
      .run('1h', new Date(Date.now() - 30 * 60_000).toISOString());
    db.close();

    // Second pass: dropStaleRollups should drop rollup_5m AND clear its
    // rollup_refresh entry. The 1h entry was never dropped (PK was fine)
    // and must remain.
    fs.writeFileSync(jsonlPath, '');
    await runOnce({ jsonlPath, dbPath });

    const db2 = new DatabaseSync(dbPath);
    const refreshGrains = new Set(db2.prepare('SELECT grain FROM rollup_refresh').all().map((r) => r.grain));
    assert.ok(!refreshGrains.has('5m'),
      `rollup_refresh for 5m should be cleared when rollup_5m is dropped, got: ${JSON.stringify([...refreshGrains])}`);
    assert.ok(refreshGrains.has('1h'),
      `rollup_refresh for 1h should be preserved when its rollup table is NOT dropped, got: ${JSON.stringify([...refreshGrains])}`);
    db2.close();
  } finally {
    cleanup();
  }
});

test('installShutdown: flushes pending events via runOnce before exiting', async () => {
  const calls = [];
  let resolveRunOnce;
  const runOnceFn = () => new Promise((resolve) => {
    resolveRunOnce = resolve;
    calls.push('runOnce');
  });
  const exit = (code) => calls.push(`exit(${code})`);
  const originalLog = console.log;
  console.log = () => {};   // silence success log during this ordering test
  const { onShutdownSignal, uninstall } = installShutdown({ runOnceFn, exit });
  try {
    const pending = onShutdownSignal();
    // exit() must not fire until the flush settles.
    assert.deepEqual(calls, ['runOnce']);
    resolveRunOnce({ inserted: 1, truncated: true });
    await pending;
    assert.deepEqual(calls, ['runOnce', 'exit(0)']);
  } finally {
    console.log = originalLog;
    uninstall();
  }
});

test('installShutdown: a duplicate signal does not re-enter the flush', async () => {
  let runOnceCalls = 0;
  const runOnceFn = () => { runOnceCalls++; return Promise.resolve({ inserted: 0, truncated: false }); };
  const exitCalls = [];
  const exit = (code) => exitCalls.push(code);
  const originalLog = console.log;
  console.log = () => {};   // silence no-flush log during this counter test
  const { onShutdownSignal, uninstall } = installShutdown({ runOnceFn, exit });
  try {
    await onShutdownSignal();
    await onShutdownSignal();
    assert.equal(runOnceCalls, 1);
    assert.deepEqual(exitCalls, [0]);
  } finally {
    console.log = originalLog;
    uninstall();
  }
});

test('installShutdown: a flush failure still exits(0) rather than hanging', async () => {
  const runOnceFn = () => Promise.reject(new Error('disk full'));
  const exitCalls = [];
  const exit = (code) => exitCalls.push(code);
  const originalError = console.error;
  console.error = () => {};
  const { onShutdownSignal, uninstall } = installShutdown({ runOnceFn, exit });
  try {
    await onShutdownSignal();
  } finally {
    console.error = originalError;
    uninstall();
  }
  assert.deepEqual(exitCalls, [0]);
});

test('installShutdown: logs a no-flush-needed line when runOnce inserts zero events', async () => {
  const runOnceFn = () => Promise.resolve({ inserted: 0, truncated: false });
  const exit = () => {};
  const lines = [];
  const originalLog = console.log;
  console.log = (msg) => lines.push(msg);
  const restoreEnv = isolateLogEnv();
  const { onShutdownSignal, uninstall } = installShutdown({ runOnceFn, exit });
  try {
    await onShutdownSignal();
  } finally {
    console.log = originalLog;
    uninstall();
    restoreEnv();
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[stats-batcher\] shutdown: no pending events to flush/);
});

test('installShutdown: logs a success line with the inserted count when runOnce flushes events', async () => {
  const runOnceFn = () => Promise.resolve({ inserted: 42, truncated: true });
  const exit = () => {};
  const lines = [];
  const originalLog = console.log;
  console.log = (msg) => lines.push(msg);
  const restoreEnv = isolateLogEnv();
  const { onShutdownSignal, uninstall } = installShutdown({ runOnceFn, exit });
  try {
    await onShutdownSignal();
  } finally {
    console.log = originalLog;
    uninstall();
    restoreEnv();
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[stats-batcher\] shutdown: flushed 42 event\(s\) to DB/);
});

test('installShutdown: logs a failure line via console.error when runOnce rejects', async () => {
  const runOnceFn = () => Promise.reject(new Error('disk full'));
  const exit = () => {};
  const lines = [];
  const originalError = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  const restoreEnv = isolateLogEnv();
  const { onShutdownSignal, uninstall } = installShutdown({ runOnceFn, exit });
  try {
    await onShutdownSignal();
  } finally {
    console.error = originalError;
    uninstall();
    restoreEnv();
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[stats-batcher\] shutdown: final flush failed:/);
  assert.match(lines[0], /disk full/);
});
