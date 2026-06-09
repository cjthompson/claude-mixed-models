#!/usr/bin/env node
// Usage-stats CLI. One-shot by default; --watch re-renders every 5s.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import {
  requestsByHourOfDay,
  topModels,
  topSessions,
  errorsByStatus,
  todaysTotals,
} from '../stats/queries.mjs';

const DB_PATH = process.env.STATS_DB_PATH ?? `${process.env.HOME}/.local/state/claude-mixed-models/router.stats.db`;
const WATCH = process.argv.includes('--watch');
const RANGE = (process.argv.find((a) => a.startsWith('--range='))?.slice('--range='.length)) ?? '7d';

const RESET = '\x1b[0m';
const FG = {
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  red:   '\x1b[31m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  blue:  '\x1b[34m',
  cyan:  '\x1b[36m',
};

function abbrev(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (Math.round(n / 100) / 10) + 'k';
  return (Math.round(n / 100_000) / 10) + 'M';
}

function color(s, code) { return `${code}${s}${RESET}`; }

function renderCards(db) {
  const totals  = todaysTotals(db);
  const models  = topModels(db, RANGE, 5);
  const sessions = topSessions(db, RANGE, 5);
  const errors  = errorsByStatus(db, '24h');
  const hours   = requestsByHourOfDay(db, RANGE);

  const out = [];
  out.push(color(`Usage stats · range=${RANGE}`, FG.bold));
  out.push('');
  out.push(`${color('Today', FG.dim)}                  ${color(abbrev(totals.requests), FG.cyan)} requests · ${color(abbrev(totals.input_tokens), FG.blue)} in · ${color(abbrev(totals.output_tokens), FG.cyan)} out`);
  out.push('');
  out.push(color('Top models', FG.bold));
  for (const m of models) {
    const errRate = m.requests > 0 ? (m.errors / m.requests * 100).toFixed(1) : '0.0';
    const errColor = m.errors > 0 ? FG.red : FG.dim;
    out.push(`  ${m.model.padEnd(28)} ${color(String(m.requests).padStart(6), FG.cyan)} reqs · ${color(abbrev(m.input_tokens).padStart(7), FG.blue)} in · ${color(abbrev(m.output_tokens).padStart(6), FG.cyan)} out · ${color(errRate.padStart(5) + '%', errColor)} err`);
  }
  out.push('');
  out.push(color('Top sessions', FG.bold));
  for (const s of sessions) {
    out.push(`  ${(s.session_id ?? '—').slice(0, 8).padEnd(10)} ${color(String(s.requests).padStart(5), FG.cyan)} reqs · ${color(abbrev(s.tokens).padStart(7), FG.blue)} tokens`);
  }
  out.push('');
  out.push(color('Requests by hour-of-day', FG.bold));
  const max = Math.max(...hours.map((h) => h.requests), 1);
  for (const h of hours) {
    const bar = '█'.repeat(Math.round((h.requests / max) * 20)).padEnd(20, ' ');
    out.push(`  ${String(h.hour).padStart(2, '0')}:00  ${color(bar, FG.cyan)} ${h.requests}`);
  }
  out.push('');
  out.push(color('Errors (last 24h)', FG.bold));
  if (errors.length === 0) out.push(color('  none', FG.green));
  for (const e of errors) out.push(`  ${color(e.status, FG.red)}: ${e.count}`);
  return out.join('\n');
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.log('no data yet');
    return;
  }
  if (WATCH) {
    const render = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      try {
        const db = new DatabaseSync(DB_PATH, { readOnly: true });
        console.log(renderCards(db));
        db.close();
      } catch (err) {
        console.error('error:', err.message);
      }
    };
    render();
    setInterval(render, 5_000);
  } else {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    console.log(renderCards(db));
    db.close();
  }
}

main();
