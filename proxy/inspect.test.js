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

test('extractUsageFromSse: pulls cache token counts from message_start', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":1234,"cache_read_input_tokens":0}}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const usage = extractUsageFromSse(sse);
  assert.equal(usage.cache_creation_input_tokens, 1234);
  assert.equal(usage.cache_read_input_tokens, 0);
});

test('extractUsageFromSse: returns null when no usage present', () => {
  assert.equal(extractUsageFromSse('event: ping\ndata: {}\n\n'), null);
});
