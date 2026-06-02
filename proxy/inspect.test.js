import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasCacheControl, extractUsageFromSse } from './inspect.js';

test('hasCacheControl: detects cache_control in system blocks', () => {
  const body = {
    model: 'x',
    system: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
    messages: [],
  };
  assert.equal(hasCacheControl(body), true);
});

test('hasCacheControl: detects cache_control in tools', () => {
  const body = { tools: [{ name: 't', cache_control: { type: 'ephemeral' } }], messages: [] };
  assert.equal(hasCacheControl(body), true);
});

test('hasCacheControl: false when no breakpoints anywhere', () => {
  const body = { system: 'plain string', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(hasCacheControl(body), false);
});

test('extractUsageFromSse: returns the last usage object seen, so output_tokens from message_delta is captured', () => {
  // Anthropic streams prompt-side usage on message_start and output_tokens
  // (plus total) on message_delta. We want both in one return value.
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":1234,"cache_read_input_tokens":0}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":42,"cache_creation_input_tokens":1234,"cache_read_input_tokens":0,"total_tokens":52}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const usage = extractUsageFromSse(sse);
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.cache_creation_input_tokens, 1234);
  assert.equal(usage.cache_read_input_tokens, 0);
  assert.equal(usage.output_tokens, 42);
  assert.equal(usage.total_tokens, 52);
});

test('extractUsageFromSse: still works on a single message_start with no following message_delta', () => {
  // The fallback in proxy/server.js calls JSON.parse(text).usage; that path
  // is independent of extractUsageFromSse, but verify extractUsageFromSse
  // also handles a single message_start with no following message_delta.
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
    '',
  ].join('\n');
  const usage = extractUsageFromSse(sse);
  assert.equal(usage.input_tokens, 7);
});

test('extractUsageFromSse: returns null when no usage present', () => {
  assert.equal(extractUsageFromSse('event: ping\ndata: {}\n\n'), null);
});
