#!/usr/bin/env node
// Orchestrator for the usage-stats system.
// Spawns the batcher and HTTP server as child processes; respawns on crash;
// forwards SIGTERM to all children and waits for them to exit.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const STATS_DIR = join(here, '..', 'stats');
const SCRIPTS = [
  join(STATS_DIR, 'workers', 'batcher.mjs'),
  join(STATS_DIR, 'workers', 'server.mjs'),
];

const procs = new Map();
let shuttingDown = false;

function start(script) {
  const child = spawn('node', [script], { stdio: 'inherit' });
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
