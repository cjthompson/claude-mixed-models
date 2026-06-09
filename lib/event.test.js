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
    logEvent({ path, id: 'bbbbbbbb' });
    assert.ok(existsSync(path), 'expected file to exist after mkdir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logEvent: does not throw on a bad path (e.g. unwritable)', () => {
  // /dev/null/foo is not a valid path; appendFileSync will fail.
  // The function must swallow the error so it never breaks the router.
  assert.doesNotThrow(() => logEvent({ path: '/dev/null/foo/events.jsonl', id: 'cccccccc' }));
});

test('logEvent: appends multiple lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'event-test-'));
  const path = join(dir, 'events.jsonl');
  try {
    logEvent({ path, id: '1' });
    logEvent({ path, id: '2' });
    logEvent({ path, id: '3' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l) => JSON.parse(l).id), ['1', '2', '3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
