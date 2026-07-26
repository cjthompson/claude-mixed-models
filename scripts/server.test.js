// Unit tests for the orchestrator in server.mjs. No real child processes —
// spawnFn is injected as a fake EventEmitter-like object so shutdown() can
// be driven directly and exitFn observed without killing the test runner.
// setTimeoutFn/clearTimeoutFn are likewise injected so respawn-backoff
// scheduling can be driven deterministically, without waiting out real
// backoff delays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOrchestrator } from './server.mjs';

// A fake child_process.ChildProcess: an EventEmitter with a `kill()` that
// records calls and fires `exit` on the next microtask (mirroring the real
// async exit of a killed process). `opts.childrenByScript` (if provided) is
// populated so a test can grab a handle to a specific spawned child and
// drive its own `exit` event directly (simulating a crash). `opts.killsByScript`
// tracks how many times kill() was called on each script's child, so a test
// can assert a specific (e.g. stale) child was never re-killed.
// `opts.spawnLog` records every script spawnFn was invoked for, in order.
function fakeSpawn(kills, opts = {}) {
  const { childrenByScript, killsByScript, spawnLog } = opts;
  return (execPath, args) => {
    const script = args[0];
    if (spawnLog) spawnLog.push(script);
    const child = new EventEmitter();
    child.kill = (signal) => {
      kills.push(signal);
      if (killsByScript) killsByScript.set(script, (killsByScript.get(script) ?? 0) + 1);
      queueMicrotask(() => child.emit('exit', null, signal));
    };
    if (childrenByScript) childrenByScript.set(script, child);
    return child;
  };
}

// A minimal fake timer registry standing in for setTimeout/clearTimeout:
// setTimeoutFn records the callback under a numeric id instead of actually
// scheduling anything — nothing fires until the test calls fireAll()
// explicitly (which this suite never needs to, since a cancelled timer
// should never fire). clearTimeoutFn removes a pending callback.
function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutFn(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeoutFn(id) {
      pending.delete(id);
    },
    pendingCount() {
      return pending.size;
    },
    fireAll() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
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

  try {
    await orch.shutdown('SIGTERM');

    assert.deepEqual(kills, ['SIGTERM', 'SIGTERM']);
    assert.deepEqual(exitCalls, [0]);
    assert.equal(orch.shuttingDown, true);
  } finally {
    orch.uninstall();
  }
});

test('shutdown: forwards SIGINT to every child exactly once', async () => {
  const kills = [];
  const exitCalls = [];
  const orch = createOrchestrator({
    scripts: ['a.js', 'b.js'],
    spawnFn: fakeSpawn(kills),
    exitFn: (code) => exitCalls.push(code),
  });

  try {
    await orch.shutdown('SIGINT');

    assert.deepEqual(kills, ['SIGINT', 'SIGINT']);
    assert.deepEqual(exitCalls, [0]);
    assert.equal(orch.shuttingDown, true);
  } finally {
    orch.uninstall();
  }
});

test('shutdown: a duplicate call while already shutting down is a no-op', async () => {
  const kills = [];
  const exitCalls = [];
  const orch = createOrchestrator({
    scripts: ['a.js', 'b.js', 'c.js'],
    spawnFn: fakeSpawn(kills),
    exitFn: (code) => exitCalls.push(code),
  });

  try {
    // Two SIGTERMs arriving back-to-back (the exact scenario from the bug
    // report: Docker's stop path, or an operator re-running `docker compose
    // stop`) must not forward a second real signal to any child — that would
    // force the router's "second SIGTERM" hard-kill path mid-request.
    const first = orch.shutdown('SIGTERM');
    orch.shutdown('SIGTERM');
    await first;

    assert.deepEqual(kills, ['SIGTERM', 'SIGTERM', 'SIGTERM']);
    assert.deepEqual(exitCalls, [0]);
  } finally {
    orch.uninstall();
  }
});

test('shutdown: a duplicate call with a different (mixed) signal is also a no-op', async () => {
  const kills = [];
  const exitCalls = [];
  const orch = createOrchestrator({
    scripts: ['a.js', 'b.js'],
    spawnFn: fakeSpawn(kills),
    exitFn: (code) => exitCalls.push(code),
  });

  try {
    // A SIGTERM followed immediately by a SIGINT (or vice versa) is still a
    // duplicate shutdown request — the second signal must not be forwarded to
    // any child, and it must not trigger a second exitFn() call.
    const first = orch.shutdown('SIGTERM');
    const second = orch.shutdown('SIGINT');
    await first;
    await second;

    assert.deepEqual(kills, ['SIGTERM', 'SIGTERM']);
    assert.deepEqual(exitCalls, [0]);
    // The duplicate call resolves to the same settled shutdown, not a new one.
    assert.equal(second, first);
  } finally {
    orch.uninstall();
  }
});

test('shutdown: a child that exits during respawn backoff settles promptly, is not killed again, and does not respawn later', async () => {
  const kills = [];
  const exitCalls = [];
  const childrenByScript = new Map();
  const killsByScript = new Map();
  const spawnLog = [];
  const timers = fakeTimers();
  const orch = createOrchestrator({
    scripts: ['a.js', 'b.js'],
    spawnFn: fakeSpawn(kills, { childrenByScript, killsByScript, spawnLog }),
    exitFn: (code) => exitCalls.push(code),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  try {
    assert.deepEqual(spawnLog, ['a.js', 'b.js']);

    // a.js crashes quickly (well under the backoff module's healthy-lifetime
    // threshold), so the orchestrator schedules a respawn via setTimeoutFn
    // instead of restarting it immediately.
    const staleA = childrenByScript.get('a.js');
    staleA.emit('exit', 1, null);

    assert.equal(timers.pendingCount(), 1, 'a respawn should be scheduled, not run immediately');
    assert.equal(orch.procs.has('a.js'), false, 'an exited child must be removed from procs immediately');
    assert.equal(orch.procs.get('b.js'), childrenByScript.get('b.js'), 'the still-live child must remain tracked');

    // Shutdown arrives while a.js's respawn is still pending in backoff. A
    // buggy implementation that snapshots procs before removing exited
    // children, or that never removes them at all, would try to kill() the
    // already-dead a.js and then hang forever waiting for a second 'exit'
    // event that will never come. Race against a short real timer as a
    // fail-fast guard — it is not standing in for (and is far shorter than)
    // any real backoff delay. The handle is captured so it can be cleared
    // once the race settles: an uncleared timer holds the event loop open
    // for the full 200ms even after `orch.shutdown()` already won the race,
    // needlessly slowing down the test run.
    let failSafeTimer;
    const settled = await Promise.race([
      orch.shutdown('SIGTERM').then(() => 'settled'),
      new Promise((resolve) => { failSafeTimer = setTimeout(() => resolve('timeout'), 200); }),
    ]);
    clearTimeout(failSafeTimer);
    assert.equal(settled, 'settled', 'shutdown must not hang waiting on an already-exited child');

    // Only the still-live b.js was signaled; the stale a.js child (already
    // exited before shutdown began) must not receive a second kill() call.
    assert.deepEqual(kills, ['SIGTERM']);
    assert.equal(killsByScript.get('a.js'), undefined, 'stale child must not be killed');
    assert.equal(killsByScript.get('b.js'), 1);
    assert.deepEqual(exitCalls, [0]);
    assert.equal(orch.shuttingDown, true);

    // The pending respawn timer must have been cancelled by shutdown.
    assert.equal(timers.pendingCount(), 0, 'pending respawn timer must be cancelled by shutdown');
    timers.fireAll(); // no-op: nothing should be pending
    assert.deepEqual(spawnLog, ['a.js', 'b.js'], 'no respawn should occur once shutdown has begun');
  } finally {
    orch.uninstall();
  }
});

test('respawn: a crashed child is replaced when its backoff timer fires, and procs/timers reflect the new child', async () => {
  const kills = [];
  const childrenByScript = new Map();
  const killsByScript = new Map();
  const spawnLog = [];
  const timers = fakeTimers();
  const orch = createOrchestrator({
    scripts: ['a.js', 'b.js'],
    spawnFn: fakeSpawn(kills, { childrenByScript, killsByScript, spawnLog }),
    exitFn: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  try {
    assert.deepEqual(spawnLog, ['a.js', 'b.js']);
    const staleA = childrenByScript.get('a.js');
    assert.equal(orch.procs.get('a.js'), staleA);

    // a.js crashes well under the backoff module's healthy-lifetime
    // threshold, so a respawn is scheduled via setTimeoutFn rather than run
    // immediately.
    staleA.emit('exit', 1, null);
    assert.equal(timers.pendingCount(), 1, 'a respawn should be scheduled for a.js');
    assert.equal(orch.procs.has('a.js'), false, 'the crashed child is removed from procs immediately');

    // Firing the pending timer (as the real setTimeout would once the
    // backoff delay elapses) should spawn a's replacement.
    timers.fireAll();

    assert.equal(timers.pendingCount(), 0, 'the timer registry is empty again once the respawn has fired');
    assert.deepEqual(spawnLog, ['a.js', 'b.js', 'a.js'], 'a.js was spawned a second time');

    const replacementA = childrenByScript.get('a.js');
    assert.notStrictEqual(replacementA, staleA, 'the replacement child is a new instance, not the crashed one');
    assert.equal(orch.procs.get('a.js'), replacementA, 'procs tracks the replacement child under the same script key');
    assert.equal(orch.procs.get('b.js'), childrenByScript.get('b.js'), 'the untouched sibling is still tracked');
  } finally {
    orch.uninstall();
  }
});
