import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_PATH = '/tmp/claude-mixed-models/router.events.jsonl';

// Best-effort: a failed append must never throw on the router's response path.
// `path` is overridden in tests; production callers omit it and the env var
// (or default) is used.
export function logEvent(fields) {
  const path = fields.path ?? process.env.STATS_EVENTS_FILE ?? DEFAULT_PATH;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ...fields, path: undefined, ts: new Date().toISOString() }) + '\n');
  } catch (err) {
    // Drop the event and log to stderr. The router's response path is sacred.
    console.error('[stats] logEvent failed (dropping event):', err.message);
  }
}
