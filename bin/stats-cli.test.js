import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOnce } from '../stats/workers/batcher.mjs';

test('stats CLI: mixed-provider context and session totals include cache categories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-cli-'));
  try {
    const jsonlPath = join(dir, 'events.jsonl');
    const dbPath = join(dir, 'stats.db');
    const ts = new Date().toISOString();
    writeFileSync(jsonlPath, [
      JSON.stringify({
        id: 'openai', ts, model: 'gpt-5', real_model: 'gpt-5', upstream: 'api.openai.com',
        status: 200, durationMs: 10, sessionId: 'openai-session',
        input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 700,
        cache_creation_input_tokens: 200, cache_5m_input_tokens: 0,
        cache_1h_input_tokens: 0, thinking_tokens: 30,
      }),
      JSON.stringify({
        id: 'anthropic', ts, model: 'claude-sonnet', real_model: 'claude-sonnet-4-6', upstream: 'api.anthropic.com',
        status: 200, durationMs: 10, sessionId: 'anthropic-session',
        input_tokens: 400, output_tokens: 40, cache_read_input_tokens: 300,
        cache_creation_input_tokens: 100, cache_5m_input_tokens: 0,
        cache_1h_input_tokens: 100, thinking_tokens: 20,
      }),
    ].join('\n') + '\n');
    await runOnce({ jsonlPath, dbPath });

    const raw = execFileSync(process.execPath, ['bin/stats-cli.mjs', '--range=all'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, STATS_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    const output = raw.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(output, /Today\s+2 requests · 1\.8k in · 90 out/);
    assert.match(output, /gpt-5\s+\s+1 reqs ·\s+1k in ·\s+50 out/);
    assert.match(output, /claude-sonnet\s+\s+1 reqs ·\s+800 in ·\s+40 out/);
    assert.match(output, /openai-s\s+\s+1 reqs ·\s+1\.1k tokens/);
    assert.match(output, /anthropi\s+\s+1 reqs ·\s+840 tokens/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
