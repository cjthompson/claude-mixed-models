import { appendFileSync, mkdirSync } from 'node:fs';

const SSE_SAMPLE_DIR = '/tmp/claude-mixed-models/sse-samples';
const SSE_SAMPLE_LIMIT = 100;

export function createSampler() {
  mkdirSync(SSE_SAMPLE_DIR, { recursive: true });
  const counts = new Map();
  return function sampleResponse(model, id, text, reqBody) {
    const key = model ?? 'unknown';
    const count = counts.get(key) ?? 0;
    if (count >= SSE_SAMPLE_LIMIT) return;
    counts.set(key, count + 1);
    try {
      const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
      const req = reqBody ? {
        stream: reqBody.stream,
        max_tokens: reqBody.max_tokens,
        messages: reqBody.messages?.length,
        tools: Array.isArray(reqBody.tools) ? reqBody.tools.map(t => t.name ?? t.type) : undefined,
        system_len: typeof reqBody.system === 'string' ? reqBody.system.length
                  : Array.isArray(reqBody.system) ? reqBody.system.reduce((n, b) => n + (b?.text?.length ?? 0), 0)
                  : undefined,
      } : undefined;
      appendFileSync(`${SSE_SAMPLE_DIR}/${safe}.jsonl`, JSON.stringify({ id, model: key, req, text }) + '\n');
    } catch {}
  };
}
