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
