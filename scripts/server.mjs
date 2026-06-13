#!/usr/bin/env node
// Single orchestration entry point for this project.
// Spawns the router, stats batcher, and stats HTTP server as child
// processes; respawns any of them on crash; forwards SIGTERM/SIGINT to
// all children and waits for them to exit.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

const procs = new Map();
let shuttingDown = false;
// Respawn discipline: exponential backoff (1, 2, 4, 8, 16, 30 s) capped, and
// give up after 10 consecutive fast crashes so a permanent failure (EADDRINUSE,
// missing env var, bad config) doesn't fill stats/server.err.log with 30 lines
// of stack trace per second forever. See scripts/server.backoff.mjs.
const backoff = createBackoff();

function start(script) {
  // Use process.execPath (the absolute path of the Node binary running
  // *this* orchestrator) rather than the bare string 'node'. launchd
  // KeepAlive services do not inherit the user's PATH, so a bare 'node'
  // resolves to ENOENT inside the child. process.execPath is correct in
  // every launch context (shell, launchd, test harness).
  const child = spawn(process.execPath, [script], { stdio: 'inherit' });
  procs.set(script, child);
  backoff.onStart(script);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;        // expected during graceful stop
    const action = backoff.onExit(script, { code, signal });
    if (action.action === 'respawn') {
      setTimeout(() => { if (!shuttingDown) start(script); }, action.delayMs);
    } else if (action.action === 'give-up') {
      // Don't race with a SIGTERM that's already in flight — the shutdown
      // handler will exit 0 cleanly via the existing promise.
      if (shuttingDown) return;
      process.exit(action.exitCode);
    }
    // 'noop' (healthy exit) needs no scheduling: the counter was already
    // reset inside onExit and the next start() reuses the same procs slot.
  });
}

for (const s of SCRIPTS) start(s);

function shutdown(signal) {
  shuttingDown = true;
  Promise.all([...procs.values()].map((c) => new Promise((resolve) => {
    c.once('exit', resolve);
    c.kill(signal);
  }))).then(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
