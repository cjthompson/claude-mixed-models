// Pure respawn scheduler for scripts/server.mjs. No child_process, no
// timers, no I/O. The orchestrator owns the actual spawn + setTimeout;
// this module decides, given a child exit event, what to do next.
//
// The contract:
//   backoff = createBackoff({ maxAttempts, healthyMs, delaysMs, log })
//   backoff.onStart(script, now?)         // call right after a successful spawn
//   action = backoff.onExit(script, {code, signal, now?, livedMs?})
//                                          // returns {action, delayMs?, exitCode?, log}
//
// Actions:
//   'respawn'  — schedule a retry after action.delayMs
//   'give-up'  — child has crashed too many times; caller should exit non-zero
//                (action.exitCode = 1). This is a global signal even when the
//                failing child is per-script: a single perma-fail should not
//                leave the rest of the stack running silently while the user
//                wonders why the dashboard is empty. launchd's KeepAlive
//                will restart the whole orchestrator.
//   'noop'     — child lived long enough to count as healthy. Counter resets
//                on the *next* onStart, so a fast second crash counts.
//
// `log` defaults to console.error so launchd captures messages into
// stats/server.err.log alongside the orchestrator's own stderr.

const DEFAULT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const DEFAULT_HEALTHY_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 10;

function delayFor(attempt, delaysMs) {
  // attempt is 1-based; index into the sequence, capped at the last entry.
  return delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
}

export function createBackoff(opts = {}) {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const healthyMs   = opts.healthyMs   ?? DEFAULT_HEALTHY_MS;
  const delaysMs    = opts.delaysMs    ?? DEFAULT_DELAYS_MS;
  const log         = opts.log         ?? ((line) => console.error(line));

  // Per-script state: { attempt, startedAt }.
  const state = new Map();

  function get(script) {
    let s = state.get(script);
    if (!s) { s = { attempt: 0, startedAt: 0 }; state.set(script, s); }
    return s;
  }

  function onStart(script, now = Date.now()) {
    const s = get(script);
    s.startedAt = now;
  }

  function onExit(script, { code, signal, now = Date.now(), livedMs } = {}) {
    const s = get(script);
    const lived = livedMs ?? (s.startedAt ? now - s.startedAt : 0);

    if (lived >= healthyMs) {
      log(`[stats] ${script} exited (code=${code} signal=${signal}, lived=${Math.round(lived / 1000)}s, healthy) — resetting retry counter`);
      // Reset only here at the boundary; the next onStart confirms a fresh
      // run is in flight. A healthy run that gets immediately replaced by
      // a fast crash will see attempt=1, not 2.
      s.attempt = 0;
      return { action: 'noop' };
    }

    s.attempt += 1;
    if (s.attempt >= maxAttempts) {
      log(`[stats] ${script} crashed ${s.attempt} times in a row (last: code=${code} signal=${signal}); giving up. launchd will restart the orchestrator.`);
      return { action: 'give-up', exitCode: 1, attempt: s.attempt };
    }

    const delayMs = delayFor(s.attempt, delaysMs);
    log(`[stats] ${script} exited (code=${code} signal=${signal}, lived=${Math.round(lived / 1000)}s); retry ${s.attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s`);
    return { action: 'respawn', delayMs, attempt: s.attempt };
  }

  return { onStart, onExit };
}
