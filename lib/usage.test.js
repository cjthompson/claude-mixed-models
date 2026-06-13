import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage } from './usage.js';

test('normalizeUsage: null input → null', () => {
  assert.equal(normalizeUsage(null), null);
});

test('normalizeUsage: undefined input → null', () => {
  assert.equal(normalizeUsage(undefined), null);
});

test('normalizeUsage: non-object input → null', () => {
  assert.equal(normalizeUsage(42), null);
  assert.equal(normalizeUsage('hello'), null);
  assert.equal(normalizeUsage(true), null);
});

test('normalizeUsage: empty object → all zeros, total null', () => {
  const out = normalizeUsage({});
  assert.equal(out.input_tokens, 0);
  assert.equal(out.output_tokens, 0);
  assert.equal(out.cache_read_input_tokens, 0);
  assert.equal(out.cache_creation_input_tokens, 0);
  assert.deepEqual(out.cache_creation, { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 });
  assert.deepEqual(out.output_tokens_details, { thinking_tokens: 0 });
  assert.equal(out.total_tokens, null);
});

test('normalizeUsage: nested cache_creation with 5m+1h → both populated, sum is cache_creation_input_tokens', () => {
  // Real Anthropic shape — the cache write counters live under
  // cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens, and there is
  // NO top-level cache_creation_input_tokens field.
  const raw = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 92488,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 266,
    },
    output_tokens_details: { thinking_tokens: 0 },
  };
  const out = normalizeUsage(raw);
  assert.equal(out.input_tokens, 100);
  assert.equal(out.output_tokens, 50);
  assert.equal(out.cache_read_input_tokens, 92488);
  assert.equal(out.cache_creation_input_tokens, 266);
  assert.equal(out.cache_creation.ephemeral_5m_input_tokens, 0);
  assert.equal(out.cache_creation.ephemeral_1h_input_tokens, 266);
  assert.equal(out.output_tokens_details.thinking_tokens, 0);
});

test('normalizeUsage: flat cache_creation_input_tokens with no nest → nested view both 0, flat is the source', () => {
  // Some compatible upstreams / older captures send the flat field only.
  // Prefer the nested view when populated; fall back to the flat value
  // (and report the TTL split as all-zero) when the nest is absent.
  const raw = {
    input_tokens: 10,
    output_tokens: 42,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 1234,
  };
  const out = normalizeUsage(raw);
  assert.equal(out.cache_creation_input_tokens, 1234);
  assert.equal(out.cache_creation.ephemeral_5m_input_tokens, 0);
  assert.equal(out.cache_creation.ephemeral_1h_input_tokens, 0);
});

test('normalizeUsage: nested view present AND flat field both sent → nested view wins, flat is ignored', () => {
  // Defense-in-depth: if an upstream ever populates both, the nest is the
  // authoritative source (it carries the TTL split). The flat sum is treated
  // as redundant and dropped.
  const raw = {
    cache_creation_input_tokens: 9999,
    cache_creation: {
      ephemeral_5m_input_tokens: 5,
      ephemeral_1h_input_tokens: 10,
    },
  };
  const out = normalizeUsage(raw);
  assert.equal(out.cache_creation_input_tokens, 15);
  assert.equal(out.cache_creation.ephemeral_5m_input_tokens, 5);
  assert.equal(out.cache_creation.ephemeral_1h_input_tokens, 10);
});

test('normalizeUsage: output_tokens_details.thinking_tokens=83 → preserved', () => {
  const raw = {
    input_tokens: 2,
    output_tokens: 1041,
    output_tokens_details: { thinking_tokens: 83 },
  };
  const out = normalizeUsage(raw);
  assert.equal(out.output_tokens_details.thinking_tokens, 83);
  // output_tokens is the model-visible total, including thinking. Don't
  // double-count: the thinking field is informational only.
  assert.equal(out.output_tokens, 1041);
});

test('normalizeUsage: no output_tokens_details → thinking_tokens=0', () => {
  // Haiku and non-thinking turns on Sonnet/Opus don't include the
  // output_tokens_details object at all. Default to 0 so consumers don't
  // have to handle the missing field specially.
  const out = normalizeUsage({ input_tokens: 3, output_tokens: 372 });
  assert.equal(out.output_tokens_details.thinking_tokens, 0);
});

test('normalizeUsage: total_tokens=109 → preserved', () => {
  const out = normalizeUsage({ input_tokens: 100, output_tokens: 9, total_tokens: 109 });
  assert.equal(out.total_tokens, 109);
});

test('normalizeUsage: no total_tokens → null (not 0)', () => {
  // Distinguish "not reported" from "reported as 0". formatUsage() in
  // lib/log.js uses null to decide whether to emit the `total:` segment.
  const out = normalizeUsage({ input_tokens: 100, output_tokens: 9 });
  assert.equal(out.total_tokens, null);
});

test('normalizeUsage: does not mutate the input', () => {
  // Pure function contract. The router reuses the same usage object in
  // several paths (logRes + logEvent), so a mutation would surprise callers.
  const raw = {
    input_tokens: 1,
    cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
    output_tokens_details: { thinking_tokens: 4 },
  };
  const snapshot = JSON.stringify(raw);
  normalizeUsage(raw);
  assert.equal(JSON.stringify(raw), snapshot);
});
