// Unit tests for the orchestrator in server.mjs. No real child processes —
// spawnFn is injected as a fake EventEmitter-like object so shutdown() can
// be driven directly and exitFn observed without killing the test runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOrchestrator } from './server.mjs';

// A fake child_process.ChildProcess: an EventEmitter with a `kill()` that
// records calls and fires `exit` on the next microtask (mirroring the real
// async exit of a killed process).
function fakeSpawn(kills) {
  return () => {
    const child = new EventEmitter();
    child.kill = (signal) => {
      kills.push(signal);
      queueMicrotask(() => child.emit('exit', null, signal));
    };
    return child;
  };
}

test('shutdown: kills every child exactly once per signal', async () => {
  const kills = [];
  const exitCalls = [];
  const orch = createOrchestrator({
    scripts: ['a.js', 'b.js'],
    spawnFn: fakeSpawn(kills),
    exitFn: (code) => exitCalls.push(code),
  });

  await orch.shutdown('SIGTERM');

  assert.deepEqual(kills, ['SIGTERM', 'SIGTERM']);
  assert.deepEqual(exitCalls, [0]);
  assert.equal(orch.shuttingDown, true);
});

test('shutdown: a duplicate call while already shutting down is a no-op', async () => {
  const kills = [];
  const exitCalls = [];
  const orch = createOrchestrator({
    scripts: ['a.js', 'b.js', 'c.js'],
    spawnFn: fakeSpawn(kills),
    exitFn: (code) => exitCalls.push(code),
  });

  // Two SIGTERMs arriving back-to-back (the exact scenario from the bug
  // report: Docker's stop path, or an operator re-running `docker compose
  // stop`) must not forward a second real signal to any child — that would
  // force the router's "second SIGTERM" hard-kill path mid-request.
  const first = orch.shutdown('SIGTERM');
  orch.shutdown('SIGTERM');
  await first;

  assert.deepEqual(kills, ['SIGTERM', 'SIGTERM', 'SIGTERM']);
  assert.deepEqual(exitCalls, [0]);
});
