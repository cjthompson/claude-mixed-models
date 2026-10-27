import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Move batcher-rejected records (those carrying a `rejectReason`) back into the
// events file so the next batcher pass retries them. Records the router wrote
// to the other-events file (no `rejectReason`) are never touched.
//
// Crash safety: events are appended before the rejected file is rewritten, so a
// crash in between only causes a second replay, which the batcher dedupes on
// (id, ts). Lines appended to the rejected file while this runs are preserved.
//
// `match` (RegExp tested against rejectReason) or `all: true` is required, so
// a bare call cannot replay records whose data problem still exists.
// `beforeRewrite` is a test seam.
export function replayRejected({ eventsPath, rejectedPath, match, all = false, dryRun = false, beforeRewrite } = {}) {
  if (!all && !(match instanceof RegExp)) {
    throw new Error('replayRejected: pass a `match` RegExp or all: true');
  }

  let text;
  try {
    text = readFileSync(rejectedPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { replayed: 0, kept: 0 };
    throw err;
  }
  const readBytes = text.length;

  const toReplay = [];
  const kept = [];
  for (const line of text.toString('utf8').split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { kept.push(line); continue; }
    const reason = rec !== null && typeof rec === 'object' ? rec.rejectReason : undefined;
    if (typeof reason !== 'string' || (!all && !match.test(reason))) { kept.push(line); continue; }
    if (typeof rec.rawLine === 'string') {
      toReplay.push(rec.rawLine);
    } else {
      const { rejectReason: _dropped, ...original } = rec;
      toReplay.push(JSON.stringify(original));
    }
  }

  const result = { replayed: toReplay.length, kept: kept.length };
  if (dryRun || toReplay.length === 0) return result;

  mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, toReplay.map((l) => l + '\n').join(''));

  beforeRewrite?.();
  // Keep anything appended after our read, then swap the file in atomically.
  const appended = readFileSync(rejectedPath).subarray(readBytes);
  const tmp = `${rejectedPath}.tmp`;
  writeFileSync(tmp, Buffer.concat([Buffer.from(kept.map((l) => l + '\n').join('')), appended]));
  renameSync(tmp, rejectedPath);
  return result;
}
