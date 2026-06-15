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
    const usage = obj?.message?.usage ?? obj?.usage;
    if (usage && typeof usage === 'object') {
      if (lastUsage === null) {
        lastUsage = { ...usage };
      } else {
        for (const [k, v] of Object.entries(usage)) {
          // For numeric fields take the max so a later event's explicit 0 can't
          // clobber a real non-zero value that arrived in an earlier event.
          lastUsage[k] = typeof v === 'number' ? Math.max(lastUsage[k] ?? 0, v) : v;
        }
      }
    }
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
      const usage = obj?.message?.usage ?? obj?.usage;
      if (usage && typeof usage === 'object') {
        if (this.#lastUsage === null) {
          this.#lastUsage = { ...usage };
        } else {
          for (const [k, v] of Object.entries(usage)) {
            this.#lastUsage[k] = typeof v === 'number' ? Math.max(this.#lastUsage[k] ?? 0, v) : v;
          }
        }
      }
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
