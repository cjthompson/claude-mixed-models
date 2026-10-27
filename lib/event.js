import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './logger.js';

const DEFAULT_PATH = '/tmp/claude-mixed-models/router.events.jsonl';

// Chat events (string `model`) go to STATS_EVENTS_FILE, which the batcher
// ingests. Everything else (model-list polls, update checks, bodyless or
// model-less requests) goes to a separate file the batcher never reads, so
// non-chat traffic can be inspected without ever blocking ingestion.
function mainPath() {
  return process.env.STATS_EVENTS_FILE ?? DEFAULT_PATH;
}

// Exported so the batcher can route rejected lines to the same file.
export function otherEventsPath(main = mainPath()) {
  return process.env.STATS_OTHER_EVENTS_FILE ?? main.replace(/(\.jsonl)?$/, '.other.jsonl');
}

function isChatEvent(fields) {
  return typeof fields.model === 'string' && fields.model !== '';
}

// Best-effort: a failed append must never throw on the router's response path.
// `path` / `otherPath` are overridden in tests; production callers omit them
// and the env vars (or defaults) are used.
export function logEvent(fields) {
  const { path: pathOverride, otherPath: otherOverride, ...rest } = fields;
  const main = pathOverride ?? mainPath();
  const path = isChatEvent(rest) ? main : (otherOverride ?? otherEventsPath(main));
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ...rest, ts: new Date().toISOString() }) + '\n');
  } catch (err) {
    // Drop the event and log to stderr. The router's response path is sacred.
    logger.error('[stats] logEvent failed (dropping event):', err.message);
  }
}
