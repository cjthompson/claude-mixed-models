import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute } from './routes.js';

const table = {
  'claude-opus-4-8': { upstream: 'anthropic', realModel: 'claude-opus-4-8' },
  'claude-sonnet-4-6': { upstream: 'anthropic', realModel: 'claude-sonnet-4-6' },
  'claude-minimax-m2': { upstream: 'minimax', realModel: 'MiniMax-M2.5' },
  'claude-haiku-4-5': { upstream: 'anthropic', realModel: 'claude-haiku-4-5-20251001' },
};

test('resolveRoute: maps an Anthropic model to the anthropic upstream unchanged', () => {
  assert.deepEqual(resolveRoute('claude-opus-4-8', table), {
    upstream: 'anthropic', realModel: 'claude-opus-4-8',
  });
});

test('resolveRoute: maps a claude-prefixed alias to the minimax upstream with rewritten model', () => {
  assert.deepEqual(resolveRoute('claude-minimax-m2', table), {
    upstream: 'minimax', realModel: 'MiniMax-M2.5',
  });
});

test('resolveRoute: returns null for an unknown model', () => {
  assert.equal(resolveRoute('gpt-9', table), null);
});

test('resolveRoute: rewrites a haiku alias to its dated real model id', () => {
  assert.deepEqual(resolveRoute('claude-haiku-4-5', table), {
    upstream: 'anthropic', realModel: 'claude-haiku-4-5-20251001',
  });
});
