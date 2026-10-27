import { logReq, logRes } from './log.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const SILENT_VALUES = new Set(['silent', 'none', 'off']);

// Re-read on every call (not cached at import) so a changed env is picked
// up immediately and tests can toggle LOG_LEVEL/DEBUG per-test without
// re-importing the module.
function threshold() {
  if (process.env.DEBUG) return LEVELS.debug;
  const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (SILENT_VALUES.has(raw)) return LEVELS.silent;
  return Object.hasOwn(LEVELS, raw) ? LEVELS[raw] : LEVELS.info;
}

function write(level, args) {
  if (LEVELS[level] < threshold()) return;
  // Look up the console method at call time — do NOT hoist/cache this.
  // Tests capture output by reassigning console.log / console.error
  // directly; a cached reference would bypass their capture.
  const sink = (level === 'error' || level === 'warn') ? console.error : console.log;
  sink(...args);
}

export const logger = {
  config: threshold,
  debug: (...args) => write('debug', args),
  info:  (...args) => write('info', args),
  warn:  (...args) => write('warn', args),
  error: (...args) => write('error', args),
  req: (id, fields) => { if (threshold() < LEVELS.silent) logReq(id, fields); },
  res: (id, fields) => { if (threshold() < LEVELS.silent) logRes(id, fields); },
};
