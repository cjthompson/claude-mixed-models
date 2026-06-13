// Unit tests for the pure respawn scheduler in server.backoff.mjs.
// No real timers, no spawned processes, no filesystem. The seam is
// `createBackoff({ log, ... })` — the test injects a log array to
// assert on message format without spying on console.error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackoff } from './server.backoff.mjs';

function setup(opts = {}) {
  const log = [];
  const backoff = createBackoff({
    log: (line) => log.push(line),
    ...opts,
  });
  return { backoff, log };
}

// 1. First crash schedules a 1 s respawn.
test('first crash: respawn after 1s, attempt 1/10', () => {
  const { backoff, log } = setup();
  backoff.onStart('router.js');
  const action = backoff.onExit('router.js', { code: 1, signal: null, livedMs: 0 });
  assert.equal(action.action, 'respawn');
  assert.equal(action.delayMs, 1000);
  assert.equal(action.attempt, 1);
  assert.equal(log.length, 1);
  assert.match(log[0], /retry 1\/10/);
  assert.match(log[0], /in 1s/);
});

// 2. Consecutive crashes follow the backoff sequence.
test('five consecutive crashes: delays 1, 2, 4, 8, 16 s', () => {
  const { backoff, log } = setup();
  backoff.onStart('router.js');
  const delays = [];
  for (let i = 0; i < 5; i++) {
    const action = backoff.onExit('router.js', { code: 1, signal: null, livedMs: 0 });
    assert.equal(action.action, 'respawn');
    delays.push(action.delayMs);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
  for (let i = 0; i < 5; i++) {
    assert.match(log[i], new RegExp(`retry ${i + 1}/10`));
  }
});

// 3. Backoff caps at the last value in the sequence.
test('attempts 7-10 all use the capped 30s delay', () => {
  const { backoff, log } = setup();
  backoff.onStart('router.js');
  const actions = [];
  for (let i = 0; i < 9; i++) {
    actions.push(backoff.onExit('router.js', { code: 1, signal: null, livedMs: 0 }));
  }
  // Attempts 1..6 follow the sequence; 7..9 should be 30000.
  assert.equal(actions[0].delayMs, 1000);
  assert.equal(actions[1].delayMs, 2000);
  assert.equal(actions[2].delayMs, 4000);
  assert.equal(actions[3].delayMs, 8000);
  assert.equal(actions[4].delayMs, 16000);
  assert.equal(actions[5].delayMs, 30000);
  assert.equal(actions[6].delayMs, 30000);
  assert.equal(actions[7].delayMs, 30000);
  assert.equal(actions[8].delayMs, 30000);
  // The 9th action is a respawn (attempt 9/10), the 10th will be give-up.
  assert.equal(actions[8].attempt, 9);
  assert.equal(actions[8].action, 'respawn');
});

// 4. 10th failure gives up with exit code 1.
test('10th consecutive failure: give-up with exit code 1', () => {
  const { backoff, log } = setup();
  backoff.onStart('router.js');
  let action;
  for (let i = 0; i < 9; i++) {
    backoff.onExit('router.js', { code: 1, signal: null, livedMs: 0 });
  }
  action = backoff.onExit('router.js', { code: 1, signal: null, livedMs: 0 });
  assert.equal(action.action, 'give-up');
  assert.equal(action.exitCode, 1);
  // The give-up log line is the last one emitted.
  const last = log[log.length - 1];
  assert.match(last, /giving up/);
  assert.match(last, /10 times in a row/);
});

// 5. A child that lived >= healthyMs resets the counter on its next exit.
test('healthy run (lived >= 5s): counter resets on next onStart', () => {
  const { backoff, log } = setup();
  backoff.onStart('router.js');
  const healthy = backoff.onExit('router.js', { code: 0, signal: null, livedMs: 6000 });
  assert.equal(healthy.action, 'noop');
  assert.match(log[log.length - 1], /healthy/);
  // New run, immediate crash → should be attempt 1, not 2.
  backoff.onStart('router.js');
  const next = backoff.onExit('router.js', { code: 1, signal: null, livedMs: 0 });
  assert.equal(next.action, 'respawn');
  assert.equal(next.attempt, 1);
  assert.equal(next.delayMs, 1000);
});

// 6. A child that lived just under healthyMs counts as a failure.
test('lived = 4999ms: counts as failure, not reset (boundary)', () => {
  const { backoff, log } = setup();
  backoff.onStart('router.js');
  const action = backoff.onExit('router.js', { code: 1, signal: null, livedMs: 4999 });
  assert.equal(action.action, 'respawn');
  assert.equal(action.attempt, 1);
  assert.equal(action.delayMs, 1000);
});

// 7. Healthy then immediate crash counts as attempt 1, not attempt 2.
test('healthy run followed by immediate crash: attempt 1, not 2', () => {
  const { backoff, log } = setup();
  // First: live 6s, healthy exit.
  backoff.onStart('router.js');
  const healthy = backoff.onExit('router.js', { code: 0, signal: null, livedMs: 6000 });
  assert.equal(healthy.action, 'noop');
  // Second: re-spawn and immediately crash.
  backoff.onStart('router.js');
  const crash = backoff.onExit('router.js', { code: 1, signal: null, livedMs: 0 });
  assert.equal(crash.action, 'respawn');
  assert.equal(crash.attempt, 1);
  assert.equal(crash.delayMs, 1000);
});

// 8. Per-script counters are independent.
test('per-script counters: router crash does not advance batcher counter', () => {
  const { backoff, log } = setup();
  backoff.onStart('router.js');
  // Three router crashes in a row.
  for (let i = 0; i < 3; i++) {
    backoff.onExit('router.js', { code: 1, signal: null, livedMs: 0 });
  }
  // Now one batcher crash.
  backoff.onStart('batcher.mjs');
  const batcher = backoff.onExit('batcher.mjs', { code: 1, signal: null, livedMs: 0 });
  assert.equal(batcher.action, 'respawn');
  assert.equal(batcher.attempt, 1);
  assert.equal(batcher.delayMs, 1000);
  // And one more router crash to confirm router is at attempt 4, not 1.
  const routerNext = backoff.onExit('router.js', { code: 1, signal: null, livedMs: 0 });
  assert.equal(routerNext.action, 'respawn');
  assert.equal(routerNext.attempt, 4);
  assert.equal(routerNext.delayMs, 8000);
});
