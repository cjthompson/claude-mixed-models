import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasCacheControl, extractUsageFromSse, SseLineScanner } from './sse.js';

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

test('extractUsageFromSse: merges usage across events — message_start input_tokens and message_delta output_tokens both appear', () => {
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

test('extractUsageFromSse: merges message_start and message_delta when message_delta omits input_tokens (MiniMax pattern)', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":1234,"cache_read_input_tokens":0}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":42,"total_tokens":52}}',
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

test('extractUsageFromSse: message_delta with explicit cr=0 does NOT overwrite a non-zero cr from message_start', () => {
  // Guard against the spread-merge clobbering real cache reads. Hypothetical
  // but plausible: message_start carries cr=5000, message_delta re-sends cr=0.
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":5000,"cache_creation_input_tokens":0}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":20,"total_tokens":120,"cache_read_input_tokens":0}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const usage = extractUsageFromSse(sse);
  assert.equal(usage.cache_read_input_tokens, 5000, 'cache reads from message_start must survive message_delta');
  assert.equal(usage.output_tokens, 20);
});

test('extractUsageFromSse: returns null when no usage present', () => {
  assert.equal(extractUsageFromSse('event: ping\ndata: {}\n\n'), null);
});

test('extractUsageFromSse: recognizes usage nested in response.completed', () => {
  const sse = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":31,"output_tokens":7,"total_tokens":38}}}\n\n';
  assert.deepEqual(extractUsageFromSse(sse), { input_tokens: 31, output_tokens: 7, total_tokens: 38 });
});

test('extractUsageFromSse: ignores malformed and unknown usage fields around a valid completion', () => {
  const sse = [
    'data: {"usage":{"input_tokens":"not-a-number","unknown_before":99,"cache_creation":{"ephemeral_5m_input_tokens":null}}}',
    '',
    'data: {"response":{"usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150,"cache_read_input_tokens":20,"cache_creation_input_tokens":10,"cache_creation":{"ephemeral_5m_input_tokens":4,"ephemeral_1h_input_tokens":6},"input_tokens_details":{"cached_tokens":20,"cache_write_tokens":10},"output_tokens_details":{"thinking_tokens":7,"reasoning_tokens":8}}}}',
    '',
    'data: {"usage":{"input_tokens":{},"output_tokens":"bad","total_tokens":null,"unknown_after":123,"cache_creation":{"ephemeral_5m_input_tokens":"bad","ephemeral_1h_input_tokens":[]},"input_tokens_details":{"cached_tokens":"bad","cache_write_tokens":null},"output_tokens_details":{"thinking_tokens":{},"reasoning_tokens":"bad"}}}',
    '',
  ].join('\n');

  assert.deepEqual(extractUsageFromSse(sse), {
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
    cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 },
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
    output_tokens_details: { thinking_tokens: 7, reasoning_tokens: 8 },
  });
});

test('extractUsageFromSse: returns null when usage contains no recognized finite counters', () => {
  assert.equal(
    extractUsageFromSse('data: {"usage":{"input_tokens":"bad","unknown":1,"cache_creation":{"ephemeral_5m_input_tokens":null}}}\n\n'),
    null,
  );
});

test('SseLineScanner: handles arbitrary fragments and an unterminated response.completed record', () => {
  const scanner = new SseLineScanner();
  const sse = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":31,"output_tokens":7,"total_tokens":38}}}';
  const splitPoints = [1, 9, 24, 43, 67, 82, sse.length];
  let start = 0;
  for (const end of splitPoints) {
    scanner.push(Buffer.from(sse.slice(start, end)));
    start = end;
  }
  scanner.flush();
  assert.deepEqual(scanner.usage, { input_tokens: 31, output_tokens: 7, total_tokens: 38 });
});

test('SseLineScanner: ignores malformed records and returns null without recognized usage', () => {
  const scanner = new SseLineScanner();
  scanner.push(Buffer.from([
    'event: ping\n',
    'data: {not-json}\n\n',
    'data: [DONE]\n\n',
    'data: {"type":"response.in_progress"}\n\n',
  ].join('')));
  scanner.flush();
  assert.equal(scanner.usage, null);
});

test('SseLineScanner: preserves valid counters when malformed usage arrives after them', () => {
  const scanner = new SseLineScanner();
  scanner.push(Buffer.from('data: {"response":{"usage":{"input_tokens":31,"input_tokens_details":{"cached_tokens":9},"output_tokens_details":{"reasoning_tokens":5}}}}\n'));
  scanner.push(Buffer.from('data: {"usage":{"input_tokens":"bad","input_tokens_details":{"cached_tokens":{}},"output_tokens_details":{"reasoning_tokens":null},"unknown":1}}'));
  scanner.flush();

  assert.deepEqual(scanner.usage, {
    input_tokens: 31,
    input_tokens_details: { cached_tokens: 9 },
    output_tokens_details: { reasoning_tokens: 5 },
  });
});
