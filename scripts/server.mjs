#!/usr/bin/env node
// Single orchestration entry point for this project.
// Spawns the router, stats batcher, and stats HTTP server as child
// processes; respawns any of them on crash; forwards SIGTERM/SIGINT to
// all children and waits for them to exit.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

function start(script) {
  // Use process.execPath (the absolute path of the Node binary running
  // *this* orchestrator) rather than the bare string 'node'. launchd
  // KeepAlive services do not inherit the user's PATH, so a bare 'node'
  // resolves to ENOENT inside the child. process.execPath is correct in
  // every launch context (shell, launchd, test harness).
  const child = spawn(process.execPath, [script], { stdio: 'inherit' });
  procs.set(script, child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;        // expected during graceful stop
    console.error(`[stats] ${script} exited (code=${code} signal=${signal}); respawning in 1s`);
    setTimeout(() => start(script), 1000);
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
