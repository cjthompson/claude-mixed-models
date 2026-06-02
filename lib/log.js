import { randomBytes } from 'node:crypto';

// 8 lowercase hex chars from 4 random bytes. e.g. '4f7a9b2c'.
// Pure function — no shared state. Each call is independent so concurrent
// requests get independent ids.
export function newRequestId() {
  return randomBytes(4).toString('hex');
}

// Current local time as 'HH:MM:SS' (24h, zero-padded). e.g. '01:23:45'.
// Reads new Date() at call time — no caching across calls, so concurrent
// log lines get distinct timestamps.
export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
