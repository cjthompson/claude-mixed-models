// Normalize an upstream usage object into a stable shape that every
// downstream consumer (console log, JSONL event, stats rollup) can rely on.
//
// Why this exists: Anthropic's usage object nests cache write counters under
// cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens and carries
// thinking cost inside output_tokens_details.thinking_tokens. Different
// models populate different combinations of these — Haiku omits
// output_tokens_details entirely; some compatible upstreams send only the
// flat cache_creation_input_tokens. Without normalization the stats
// pipeline has to handle all of these shapes per-model, and Opus's
// thinking cost is invisible because nothing reads it.
//
// Contract:
//   - Input: anything. null / undefined / non-object → returns null.
//   - Output: a fresh object every call (no input mutation).
//   - Every numeric field is present and defaults to 0 if the upstream
//     didn't report it. `total_tokens` is the one exception — it stays
//     null when not reported so formatUsage() in lib/log.js can decide
//     whether to print the `total:` segment.
export function normalizeUsage(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const c5  = raw.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const c1h = raw.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  // Anthropic nests the TTL split; some compatible upstreams send only
  // the flat cache_creation_input_tokens. Prefer the nest when it carries
  // any value (the split is the authoritative shape), and fall back to the
  // flat field — reporting it under cache_creation_input_tokens while
  // leaving the nested TTL counters at 0. If both are present the nest
  // wins and the flat sum is treated as redundant.
  const cacheWrite = c5 + c1h > 0
    ? c5 + c1h
    : (raw.cache_creation_input_tokens ?? 0);
  return {
    input_tokens: raw.input_tokens ?? 0,
    output_tokens: raw.output_tokens ?? 0,
    cache_read_input_tokens: raw.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: cacheWrite,
    cache_creation: {
      ephemeral_5m_input_tokens: c5,
      ephemeral_1h_input_tokens: c1h,
    },
    output_tokens_details: {
      thinking_tokens: raw.output_tokens_details?.thinking_tokens ?? 0,
    },
    total_tokens: raw.total_tokens ?? null,
  };
}
