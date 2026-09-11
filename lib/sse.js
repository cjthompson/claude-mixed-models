// Deep-scan an Anthropic request body for any cache_control breakpoint.
export function hasCacheControl(body) {
  let found = false;
  const walk = (node) => {
    if (found || node == null || typeof node !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(node, 'cache_control')) {
      found = true;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else {
      for (const key of Object.keys(node)) walk(node[key]);
    }
  };
  walk(body);
  return found;
}

const ROOT_USAGE_COUNTERS = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
];

const NESTED_USAGE_COUNTERS = {
  cache_creation: ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'],
  input_tokens_details: ['cached_tokens', 'cache_write_tokens'],
  output_tokens_details: ['thinking_tokens', 'reasoning_tokens'],
};

function mergeCounter(previous, value) {
  return Number.isFinite(previous) ? Math.max(previous, value) : value;
}

// Keep only the finite counters this project understands. Providers can add
// arbitrary metadata to usage events, and malformed values must never replace
// a valid counter from an earlier completion event.
function mergeUsage(previous, usage) {
  if (usage == null || typeof usage !== 'object' || Array.isArray(usage)) return previous;

  const next = previous === null ? {} : { ...previous };
  let foundCounter = false;
  for (const key of ROOT_USAGE_COUNTERS) {
    if (!Number.isFinite(usage[key])) continue;
    next[key] = mergeCounter(previous?.[key], usage[key]);
    foundCounter = true;
  }
  for (const [parent, keys] of Object.entries(NESTED_USAGE_COUNTERS)) {
    const details = usage[parent];
    if (details == null || typeof details !== 'object' || Array.isArray(details)) continue;
    let nextDetails = null;
    for (const key of keys) {
      if (!Number.isFinite(details[key])) continue;
      if (nextDetails === null) nextDetails = { ...(previous?.[parent] ?? {}) };
      nextDetails[key] = mergeCounter(previous?.[parent]?.[key], details[key]);
      foundCounter = true;
    }
    if (nextDetails !== null) next[parent] = nextDetails;
  }
  return foundCounter ? next : previous;
}

// Anthropic streams the prompt-side usage (including cache_*_input_tokens) in the
// message_start event and output_tokens + total_tokens in message_delta. Scan
// SSE text and return the last usage object seen so the caller gets a complete
// record from a single call.
export function extractUsageFromSse(sseText) {
  let lastUsage = null;
  for (const line of sseText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const usage = obj?.message?.usage ?? obj?.response?.usage ?? obj?.usage;
    lastUsage = mergeUsage(lastUsage, usage);
  }
  return lastUsage;
}

// Stateful SSE scanner for streaming use. Call push(chunk) for each Buffer
// chunk received from the upstream data event; read .usage after all chunks.
// Handles partial lines across chunk boundaries. Applies the same merge
// semantics as extractUsageFromSse so callers get identical results.
export class SseLineScanner {
  #tail = '';
  #lastUsage = null;

  push(chunk) {
    const text = this.#tail + chunk.toString('utf8');
    const lines = text.split('\n');
    // Last element is either '' (chunk ended on '\n') or a partial line.
    this.#tail = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      const usage = obj?.message?.usage ?? obj?.response?.usage ?? obj?.usage;
      this.#lastUsage = mergeUsage(this.#lastUsage, usage);
    }
  }

  // Flush any partial line held in the tail (edge case: upstream closed
  // without a trailing newline).
  flush() {
    if (this.#tail) {
      this.push(Buffer.from('\n'));
    }
  }

  get usage() {
    return this.#lastUsage;
  }
}
