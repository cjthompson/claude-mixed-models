import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We import the batcher's runOnce() so we can drive a single pass without spawning a process.
import { runOnce } from './batcher.mjs';

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
