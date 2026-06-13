// End-to-end test for the stats pipeline:
//
//   router forward() → finalize() → logEvent (JSONL) → runOnce() → SQLite events + rollup → query
//
// None of the existing test files walk this whole chain. The router test
// stops at "a JSONL line was written"; the batcher test starts from a
// hand-crafted JSONL fixture; the queries test opens a pre-populated DB.
// A regression that breaks the *contract* between them (renaming a field
// in `finalize()`'s logEvent payload, or changing the batcher's read
// shape) would slip through all three. This test drives a real request
// through the whole stack and asserts the dashboard sees what the router
// emitted.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { forward } from '../router/server.js';
import { runOnce } from './workers/batcher.mjs';
import { todaysTotals } from './queries.mjs';
import { createFakeUpstream, makeObservableReqRes, SAMPLE_SSE } from '../test-helpers/fake-upstream.mjs';

// Hermetic paths. The router's logEvent reads STATS_EVENTS_FILE; the
// batcher reads STATS_EVENTS_FILE too. We point both at the same tmpdir
// JSONL and give the batcher its own DB. node:test runs each file in its
// own process, so this doesn't collide with other suites.
process.env.NODE_TLS_REJECT_UNAUTHORIZED ||= '0';

let workDir;
const upstream = createFakeUpstream();
let counter = 0;             // unique req.url path per test

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'stats-pipeline-'));
  process.env.STATS_EVENTS_FILE = join(workDir, 'events.jsonl');
  await upstream.start();
});

after(async () => {
  await upstream.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  delete process.env.STATS_EVENTS_FILE;
});

function makeReqRes() {
  return makeObservableReqRes({ url: `/v1/messages-${++counter}` });
}

test('stats pipeline: router finalize → batcher runOnce → rollup → query', async () => {
  const conn = { url: upstream.url, key: null, auth: 'passthrough' };
  upstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SAMPLE_SSE);
  };

  const jsonlPath = process.env.STATS_EVENTS_FILE;
  const dbPath = join(workDir, 'stats.db');

  // 1. Drive a real request through forward(). SAMPLE_SSE carries
  //    input_tokens=10, cache_creation=1234, output_tokens=42, no
  //    thinking, no TTL split — the "small request" path. The router's
  //    normalizeUsage() will flatten everything to the schema the batcher
  //    expects, including a zero cache_5m/1h/thinking.
  const { req, res } = makeReqRes();
  forward(req, res, conn, Buffer.from('{"model":"minimax"}'), {
    id: 'pipe-test',
    t0: Date.now() - 5,
    session: 'pipe-session',
    model: 'minimax',
    realModel: 'MiniMax-M3',
  });
  await new Promise((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
    setTimeout(() => reject(new Error('forward timed out after 5s')), 5000);
  });

  // 2. The JSONL must now have exactly one line, written by finalize().
  assert.ok(existsSync(jsonlPath), 'router should have written the JSONL line');
  const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected 1 JSONL line, got ${lines.length}`);
  const rec = JSON.parse(lines[0]);
  // Field-name contract: if the router renames any of these, the
  // batcher will silently insert 0 (or NULL) and the dashboard will
  // undercount. Pin the exact names here.
  assert.equal(rec.id, 'pipe-test');
  assert.equal(rec.model, 'minimax');
  assert.equal(rec.real_model, 'MiniMax-M3');
  assert.equal(rec.status, 200);
  assert.equal(rec.sessionId, 'pipe-session');
  assert.equal(rec.input_tokens, 10);
  assert.equal(rec.output_tokens, 42);
  assert.equal(rec.cache_read_input_tokens, 0);
  assert.equal(rec.cache_creation_input_tokens, 1234);
  assert.equal(rec.cache_5m_input_tokens, 0);
  assert.equal(rec.cache_1h_input_tokens, 0);
  assert.equal(rec.thinking_tokens, 0);

  // 3. Drain the JSONL into SQLite. runOnce() returns inserted count and
  //    truncates the file on success.
  const result = await runOnce({ jsonlPath, dbPath });
  assert.equal(result.inserted, 1, 'batcher should have inserted 1 row');
  assert.equal(result.truncated, true, 'batcher should have truncated the JSONL');
  assert.equal(readFileSync(jsonlPath, 'utf8'), '', 'JSONL must be empty after a successful pass');

  // 4. The events table must hold the row verbatim, with the same field
  //    names the dashboard reads.
  const db = new DatabaseSync(dbPath);
  const event = db.prepare(`SELECT * FROM events WHERE id='pipe-test'`).get();
  assert.ok(event, 'events row should exist');
  assert.equal(event.model, 'minimax');
  assert.equal(event.real_model, 'MiniMax-M3');
  assert.match(event.upstream, /^127\.0\.0\.1(:\d+)?$/);
  assert.equal(event.status, 200);
  assert.equal(event.session_id, 'pipe-session');
  assert.equal(event.input_tokens, 10);
  assert.equal(event.output_tokens, 42);
  assert.equal(event.cache_creation_input_tokens, 1234);
  assert.equal(event.cache_5m_input_tokens, 0);
  assert.equal(event.cache_1h_input_tokens, 0);
  assert.equal(event.thinking_tokens, 0);

  // 5. The 5m rollup must aggregate the row. The bucket key is the
  //    (model, upstream) pair + the current 5m window; we just assert
  //    the sums rather than computing the exact bucket.
  const rollup = db.prepare(`SELECT requests, input_tokens, output_tokens, cache_write FROM rollup_5m WHERE model='minimax'`).get();
  assert.ok(rollup, 'rollup_5m row should exist for minimax');
  assert.equal(rollup.requests, 1);
  assert.equal(rollup.input_tokens, 10);
  assert.equal(rollup.output_tokens, 42);
  assert.equal(rollup.cache_write, 1234);

  // 6. todaysTotals() is what the dashboard hits on the home page.
  //    The run just happened, so today's bucket must contain our row.
  const totals = todaysTotals(db);
  assert.equal(totals.requests, 1);
  assert.equal(totals.input_tokens, 10);
  assert.equal(totals.output_tokens, 42);
  assert.equal(totals.cache_write, 1234);
  assert.equal(totals.thinking, 0);

  db.close();
});

// Second test exercises the field name contract with a *different* SSE
// shape: thinking tokens and a 1h cache_creation entry. The hand-written
// batcher fixture covers this case in isolation, but the value of
// re-running it through the real router is that the
// `normalizeUsage()` flattening (which the batcher test skips) is
// actually exercised end-to-end. If a future refactor drops the
// `cache_creation.ephemeral_1h_input_tokens` walk in server.js, this
// test catches it — the existing batcher test would not.
test('stats pipeline: thinking tokens and 1h cache TTL survive the whole chain', async () => {
  const conn = { url: upstream.url, key: null, auth: 'passthrough' };
  upstream.respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":267014},"cache_read_input_tokens":0}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"input_tokens":2,"output_tokens":1041,"output_tokens_details":{"thinking_tokens":83},"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":267014},"cache_read_input_tokens":0}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n'));
  };

  const jsonlPath = process.env.STATS_EVENTS_FILE;
  // Use a fresh DB so totals from the previous test don't bleed in.
  const dbPath = join(workDir, 'stats2.db');

  const { req, res } = makeReqRes();
  forward(req, res, conn, Buffer.from('{"model":"opus"}'), {
    id: 'pipe-thinking',
    t0: Date.now() - 5,
    session: null,
    model: 'opus',
    realModel: 'claude-opus-4-8',
  });
  await new Promise((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
    setTimeout(() => reject(new Error('forward timed out after 5s')), 5000);
  });

  // The JSONL line carries the TTL split and thinking tokens as flat
  // fields — this is the contract the batcher depends on.
  const rec = JSON.parse(readFileSync(jsonlPath, 'utf8').trim().split('\n').pop());
  assert.equal(rec.cache_1h_input_tokens, 267014);
  assert.equal(rec.cache_5m_input_tokens, 0);
  assert.equal(rec.thinking_tokens, 83);

  const result = await runOnce({ jsonlPath, dbPath });
  assert.equal(result.inserted, 1);

  const db = new DatabaseSync(dbPath);
  const rollup = db.prepare(`SELECT cache_5m, cache_1h, thinking, output_tokens FROM rollup_5m WHERE model='opus'`).get();
  assert.equal(rollup.cache_5m, 0);
  assert.equal(rollup.cache_1h, 267014);
  assert.equal(rollup.thinking, 83);
  assert.equal(rollup.output_tokens, 1041);
  db.close();
});
