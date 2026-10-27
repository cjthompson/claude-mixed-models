import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replayRejected } from './replay-rejected.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'replay-test-'));
  return {
    eventsPath: join(dir, 'events.jsonl'),
    rejectedPath: join(dir, 'events.other.jsonl'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const lines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rej = (id, reason, extra = {}) => JSON.stringify({ id, ts: '2026-10-27T00:00:00.000Z', model: 'm', rejectReason: reason, ...extra });

test('replayRejected: moves matching rejects back to the events file without rejectReason', () => {
  const { eventsPath, rejectedPath, cleanup } = setup();
  try {
    writeFileSync(rejectedPath, [
      rej('a', 'NOT NULL constraint failed: events.ts'),
      rej('b', 'missing or non-string model'),
      JSON.stringify({ id: 'router-other', model: null, method: 'GET', requestPath: '/openai/models' }),   // no rejectReason: router-written
    ].join('\n') + '\n');

    const result = replayRejected({ eventsPath, rejectedPath, match: /NOT NULL/ });

    assert.deepEqual(result, { replayed: 1, kept: 2 });
    const replayed = lines(eventsPath);
    assert.deepEqual(replayed.map((r) => r.id), ['a']);
    assert.ok(!('rejectReason' in replayed[0]));
    assert.equal(replayed[0].ts, '2026-10-27T00:00:00.000Z', 'original timestamp preserved');
    assert.deepEqual(lines(rejectedPath).map((r) => r.id), ['b', 'router-other']);
  } finally {
    cleanup();
  }
});

test('replayRejected: all:true replays every record that has a rejectReason, never router-written ones', () => {
  const { eventsPath, rejectedPath, cleanup } = setup();
  try {
    writeFileSync(rejectedPath, [rej('a', 'x'), rej('b', 'y'), JSON.stringify({ id: 'router-other', model: null })].join('\n') + '\n');
    const result = replayRejected({ eventsPath, rejectedPath, all: true });
    assert.deepEqual(result, { replayed: 2, kept: 1 });
    assert.deepEqual(lines(rejectedPath).map((r) => r.id), ['router-other']);
  } finally {
    cleanup();
  }
});

test('replayRejected: an unparseable line is restored verbatim from rawLine', () => {
  const { eventsPath, rejectedPath, cleanup } = setup();
  try {
    writeFileSync(rejectedPath, JSON.stringify({ rawLine: '{"id":"half', rejectReason: 'unparseable JSON' }) + '\n');
    replayRejected({ eventsPath, rejectedPath, all: true });
    assert.equal(readFileSync(eventsPath, 'utf8'), '{"id":"half\n');
  } finally {
    cleanup();
  }
});

test('replayRejected: requires match or all, so a bare call cannot replay everything by accident', () => {
  const { eventsPath, rejectedPath, cleanup } = setup();
  try {
    writeFileSync(rejectedPath, rej('a', 'x') + '\n');
    assert.throws(() => replayRejected({ eventsPath, rejectedPath }), /match|all/i);
    assert.ok(!existsSync(eventsPath));
  } finally {
    cleanup();
  }
});

test('replayRejected: dryRun reports counts and changes nothing', () => {
  const { eventsPath, rejectedPath, cleanup } = setup();
  try {
    const content = rej('a', 'x') + '\n';
    writeFileSync(rejectedPath, content);
    assert.deepEqual(replayRejected({ eventsPath, rejectedPath, all: true, dryRun: true }), { replayed: 1, kept: 0 });
    assert.equal(readFileSync(rejectedPath, 'utf8'), content);
    assert.ok(!existsSync(eventsPath));
  } finally {
    cleanup();
  }
});

test('replayRejected: a missing rejected file is a no-op', () => {
  const { eventsPath, rejectedPath, cleanup } = setup();
  try {
    assert.deepEqual(replayRejected({ eventsPath, rejectedPath, all: true }), { replayed: 0, kept: 0 });
  } finally {
    cleanup();
  }
});

test('replayRejected: lines appended to the rejected file during the replay are not lost', () => {
  const { eventsPath, rejectedPath, cleanup } = setup();
  try {
    writeFileSync(rejectedPath, rej('a', 'x') + '\n');
    replayRejected({
      eventsPath, rejectedPath, all: true,
      beforeRewrite: () => appendFileSync(rejectedPath, rej('late', 'y') + '\n'),
    });
    assert.deepEqual(lines(rejectedPath).map((r) => r.id), ['late']);
  } finally {
    cleanup();
  }
});
