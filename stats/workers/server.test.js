import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, '..', 'schema.sql'), 'utf8');
const publicDir = join(here, '..', 'public');

function seed(dbPath, withRow = true) {
  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  if (withRow) {
    db.prepare(`
      INSERT INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                         input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('x1', new Date().toISOString(), 'minimax', 'MiniMax-M3', 'api.minimax.io', 200, 1000, 's1', 100, 10, 0, 0);
  }
  db.close();
}

test('startServer: GET /api/stats returns JSON for a populated DB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-test-'));
  const dbPath = join(dir, 'stats.db');
  try {
    seed(dbPath);
    const port = 18789 + Math.floor(Math.random() * 1000);
    const { url, close } = await startServer({ dbPath, port, publicDir });
    try {
      const res = await fetch(`${url}/api/stats?range=7d`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok('tokensByDay' in json);
      assert.ok('requestsByHourOfDay' in json);
      assert.ok('cacheHitRateByModel' in json);
      assert.ok('topModels' in json);
      assert.ok('topSessions' in json);
      assert.ok('errorsByStatus' in json);
      assert.ok('rangeTotals' in json);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startServer: GET / serves the dashboard HTML', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-test-'));
  const dbPath = join(dir, 'stats.db');
  try {
    seed(dbPath, false);
    const port = 18789 + Math.floor(Math.random() * 1000);
    const { url, close } = await startServer({ dbPath, port, publicDir });
    try {
      const res = await fetch(`${url}/`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /<html/i);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startServer: read-only WAL connection sees writes from a separate writer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-test-'));
  const dbPath = join(dir, 'stats.db');
  try {
    seed(dbPath, false);

    const port = 18789 + Math.floor(Math.random() * 1000);
    const { url, close } = await startServer({ dbPath, port, publicDir });
    try {
      // Open another writer and commit a row AFTER the read-only server is up.
      const w2 = new DatabaseSync(dbPath);
      w2.exec(`
        INSERT INTO events (id, ts, model, real_model, upstream, status, duration_ms, session_id,
                            input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
        VALUES ('wal-test', '${new Date().toISOString()}', 'minimax', 'MiniMax-M3', 'api.minimax.io', 200, 1000, 's', 100, 10, 0, 0);
      `);
      w2.close();

      const res = await fetch(`${url}/api/stats?range=7d`);
      const json = await res.json();
      const found = json.topSessions.find((r) => r.session_id === 's');
      assert.ok(found, `expected to find session 's' in topSessions: ${JSON.stringify(json.topSessions)}`);
    } finally {
      await close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
