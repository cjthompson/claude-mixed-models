import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logEvent } from './event.js';

test('logEvent: writes a single JSON line with the timestamp field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const path = join(dir, 'events.jsonl');
  try {
    logEvent({ path, id: 'aaaaaaaa', model: 'minimax' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.id, 'aaaaaaaa');
    assert.equal(rec.model, 'minimax');
    assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logEvent: creates the parent directory if missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const path = join(dir, 'nested', 'events.jsonl');
  try {
    logEvent({ path, id: 'bbbbbbbb', model: 'm' });
    assert.ok(existsSync(path), 'expected file to exist after mkdir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logEvent: does not throw on a bad path (e.g. unwritable)', () => {
  // /dev/null/foo is not a valid path; appendFileSync will fail.
  // The function must swallow the error so it never breaks the router.
  assert.doesNotThrow(() => logEvent({ path: '/dev/null/foo/events.jsonl', id: 'cccccccc', model: 'm' }));
});

test('logEvent: appends multiple lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const path = join(dir, 'events.jsonl');
  try {
    logEvent({ path, id: '1', model: 'm' });
    logEvent({ path, id: '2', model: 'm' });
    logEvent({ path, id: '3', model: 'm' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l) => JSON.parse(l).id), ['1', '2', '3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logEvent: a string model goes to the main file only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const path = join(dir, 'events.jsonl');
  const otherPath = join(dir, 'events.other.jsonl');
  try {
    logEvent({ path, otherPath, id: 'chat0001', model: 'claude-haiku-5-5' });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).id, 'chat0001');
    assert.ok(!existsSync(otherPath), 'chat events must not reach the other log');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logEvent: null, undefined, and non-string models go to the other file only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const path = join(dir, 'events.jsonl');
  const otherPath = join(dir, 'events.other.jsonl');
  try {
    logEvent({ path, otherPath, id: 'nullmod1', model: null });
    logEvent({ path, otherPath, id: 'undefmod' });
    logEvent({ path, otherPath, id: 'nummodel', model: 42 });
    logEvent({ path, otherPath, id: 'emptymod', model: '' });
    assert.ok(!existsSync(path), 'model-less events must not reach the batcher file');
    const ids = readFileSync(otherPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
    assert.deepEqual(ids, ['nullmod1', 'undefmod', 'nummodel', 'emptymod']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logEvent: the other file keeps request metadata and drops the path overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const path = join(dir, 'events.jsonl');
  const otherPath = join(dir, 'events.other.jsonl');
  try {
    logEvent({ path, otherPath, id: 'meta0001', model: null, method: 'GET', requestPath: '/openai/models' });
    const rec = JSON.parse(readFileSync(otherPath, 'utf8'));
    assert.equal(rec.method, 'GET');
    assert.equal(rec.requestPath, '/openai/models');
    assert.ok(!('path' in rec) && !('otherPath' in rec));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logEvent: the other file defaults to STATS_OTHER_EVENTS_FILE, else the main path with .other.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const saved = { main: process.env.STATS_EVENTS_FILE, other: process.env.STATS_OTHER_EVENTS_FILE };
  try {
    process.env.STATS_EVENTS_FILE = join(dir, 'router.events.jsonl');
    delete process.env.STATS_OTHER_EVENTS_FILE;
    logEvent({ id: 'derive01', model: null });
    assert.ok(existsSync(join(dir, 'router.events.other.jsonl')), 'derived from STATS_EVENTS_FILE');

    process.env.STATS_OTHER_EVENTS_FILE = join(dir, 'custom.jsonl');
    logEvent({ id: 'envpath1', model: null });
    assert.ok(existsSync(join(dir, 'custom.jsonl')), 'explicit env var wins');
  } finally {
    for (const [k, v] of [['STATS_EVENTS_FILE', saved.main], ['STATS_OTHER_EVENTS_FILE', saved.other]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
