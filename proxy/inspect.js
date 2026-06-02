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
    if (usage && typeof usage === 'object') lastUsage = usage;
  }
  return lastUsage;
}
