#!/usr/bin/env node
// Single orchestration entry point for this project.
// Spawns the router, stats batcher, and stats HTTP server as child
// processes; respawns any of them on crash; forwards SIGTERM/SIGINT to
// all children and waits for them to exit.

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createBackoff } from './server.backoff.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(here, '..');
const STATS_DIR = join(PROJECT_DIR, 'stats');
// Single entry point for every long-running Node process in this project.
// The router was previously its own launchd plist; it now lives here so
// the orchestrator can supervise it on the same respawn + signal-forward
// contract as the stats workers.
const SCRIPTS = [
  join(PROJECT_DIR, 'router', 'server.js'),
  join(STATS_DIR, 'workers', 'batcher.mjs'),
  join(STATS_DIR, 'workers', 'server.mjs'),
];

// Factory so tests can inject a fake `spawnFn`/`exitFn` and drive shutdown()
// directly instead of launching real Node processes. Wires
// `process.on('SIGTERM'/'SIGINT', ...)` unconditionally (same convention as
// router/server.js's installShutdown) — harmless in tests since they call
// the returned `shutdown` directly rather than emitting real signals.
export function createOrchestrator({
  scripts = SCRIPTS,
  spawnFn = spawn,
  exitFn = process.exit,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const procs = new Map();   // script -> currently-live child, removed on exit
  const timers = new Map();  // script -> pending respawn timer handle
  let shuttingDown = false;
  let shutdownPromise = null;
  const backoff = createBackoff();

  function start(script) {
    // Use process.execPath (the absolute path of the Node binary running
    // *this* orchestrator) rather than the bare string 'node'. launchd
    // KeepAlive services do not inherit the user's PATH, so a bare 'node'
    // resolves to ENOENT inside the child. process.execPath is correct in
    // every launch context (shell, launchd, test harness).
    const child = spawnFn(process.execPath, [script], { stdio: 'inherit' });
    procs.set(script, child);
    backoff.onStart(script);
    child.on('exit', (code, signal) => {
      // Identity-safe removal: only clear this script's slot if `child` is
      // still the current occupant of it. Guards against this handler
      // clobbering a newer child that has since taken the slot (e.g. a
      // respawn that raced ahead of this exit event being processed).
      if (procs.get(script) === child) procs.delete(script);
      if (shuttingDown) return;        // expected during graceful stop
      const action = backoff.onExit(script, { code, signal });
      if (action.action === 'respawn') {
        const timer = setTimeoutFn(() => {
          timers.delete(script);
          // Re-check even though shutdown() also cancels this timer: keeps
          // the callback safe on its own if it's ever invoked directly (as
          // tests do) without going through clearTimeoutFn first.
          if (!shuttingDown) start(script);
        }, action.delayMs);
        timers.set(script, timer);
      } else if (action.action === 'give-up') {
        // No `shuttingDown` re-check needed here: the `if (shuttingDown) return;`
        // guard above already exits this handler when shutdown is in flight,
        // so reaching this branch means it wasn't.
        exitFn(action.exitCode);
      }
      // 'noop' (healthy exit) needs no scheduling here: the retry counter
      // was already reset inside onExit, and the slot this script occupied
      // in `procs` was cleared above and stays empty. Nothing calls start()
      // again for a healthy exit — only a crash (via the 'respawn' branch)
      // brings the script back.
    });
  }

  for (const s of scripts) start(s);

  function shutdown(signal) {
    // A duplicate SIGTERM/SIGINT (Docker's stop path, an operator re-running
    // `docker compose stop`, a supervisor re-delivering the signal, or a
    // mixed pair like SIGTERM then SIGINT) must not re-signal
    // already-shutting-down children a second time — that forces the
    // router's "second SIGTERM" hard-kill path and drops in-flight requests
    // that were still draining gracefully.
    if (shuttingDown) return shutdownPromise;
    shuttingDown = true;

    // Cancel every pending respawn timer so a child that crashed during its
    // backoff wait doesn't get spawned after we've already started tearing
    // down (the timer callback also re-checks shuttingDown as a belt-and-
    // braces guard, but cancelling here is what actually stops it firing).
    for (const timer of timers.values()) clearTimeoutFn(timer);
    timers.clear();

    // Snapshot only currently-live children. A child that already exited
    // (e.g. it crashed and is sitting in backoff, waiting to respawn) was
    // already removed from `procs` by the identity-safe removal above, so
    // it never lands in this snapshot. That matters: calling kill() on an
    // already-exited child would be a pointless no-op at best, and waiting
    // on its 'exit' event would hang forever since that event already
    // fired. An empty snapshot (all children already exited) resolves
    // Promise.all([]) immediately, so shutdown still settles promptly.
    const live = [...procs.values()];
    shutdownPromise = Promise.all(live.map((c) => new Promise((resolve) => {
      c.once('exit', resolve);
      c.kill(signal);
    }))).then(() => exitFn(0));
    return shutdownPromise;
  }

  const onSigterm = () => shutdown('SIGTERM');
  const onSigint = () => shutdown('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  return {
    procs,
    shutdown,
    get shuttingDown() { return shuttingDown; },
    // Test-only seam: detaches the two process-level listeners this call
    // installed. Production never calls this — the real orchestrator keeps
    // exactly one SIGTERM/SIGINT listener pair for its lifetime. Each test
    // calls createOrchestrator() fresh, so without this every test run
    // would leave another pair of listeners on `process`, accumulating
    // toward Node's MaxListeners warning and letting Ctrl-C during a later
    // test drive a stale orchestrator's shutdown() instead of (or in
    // addition to) the live one's.
    uninstall() {
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
    },
  };
}

// Entry-point guard, same convention as router/server.js: only spawn real
// children when this module is the script Node was told to run, not when a
// test imports it.
const isEntry = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntry) {
  createOrchestrator();
}
