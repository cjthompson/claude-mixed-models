import http from 'node:http';
import https from 'node:https';
import { extractUsageFromSse, hasCacheControl } from './inspect.js';
import { newRequestId, logReq, logRes, sessionIdFromUserId } from '../lib/log.js';

const PORT = Number(process.env.PROXY_PORT ?? 8787);
const UPSTREAM = new URL(process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/anthropic');
const KEY = process.env.MINIMAX_API_KEY;

if (!KEY) {
  console.error('MINIMAX_API_KEY is not set. Aborting.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('error', (e) => console.error('[REQ ERROR]', e.message));
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const id = newRequestId();
    const t0 = Date.now();

    // Try to parse the body for REQ-line fields. Failures degrade gracefully —
    // we still log a REQ line with method/url only.
    let parsed = null;
    if (raw.length) {
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        // Body wasn't JSON. Leave parsed=null and skip model/user fields.
      }
    }
    logReq(id, {
      model: parsed?.model,
      upstream: UPSTREAM.host,
      session: sessionIdFromUserId(parsed?.metadata?.user_id),
    });
    // Phase 0 diagnostic: surface whether the request body contains a
    // cache_control breakpoint. Not part of the REQ line by design (see
    // 2026-06-02-routing-logging.md).
    if (parsed) {
      console.log(`  [diag] id=${id} cache_control_present=${hasCacheControl(parsed)}`);
    }

    const upstreamPath = UPSTREAM.pathname.replace(/\/$/, '') + req.url;
    const headers = { ...req.headers };
    headers.host = UPSTREAM.host;
    headers['x-api-key'] = KEY;
    headers.authorization = `Bearer ${KEY}`;
    headers['content-length'] = String(raw.length);

    const upstreamReq = https.request(
      {
        protocol: UPSTREAM.protocol,
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port || 443,
        method: req.method,
        path: upstreamPath,
        headers,
      },
      (upstreamRes) => {
        const safeHeaders = { ...upstreamRes.headers };
        for (const h of ['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']) delete safeHeaders[h];
        res.writeHead(upstreamRes.statusCode ?? 502, safeHeaders);
        const respChunks = [];
        upstreamRes.on('data', (c) => {
          respChunks.push(c);
          res.write(c);
        });
        upstreamRes.on('end', () => {
          res.end();
          const text = Buffer.concat(respChunks).toString('utf8');
          const usage = extractUsageFromSse(text) ??
            (() => { try { return JSON.parse(text).usage ?? null; } catch { return null; } })();
          logRes(id, {
            upstream: UPSTREAM.host,
            status: upstreamRes.statusCode ?? 502,
            durationMs: Date.now() - t0,
            usage,
            session: sessionIdFromUserId(parsed?.metadata?.user_id),
          });
        });
      }
    );
    upstreamReq.on('error', (err) => {
      console.error('[UPSTREAM ERROR]', err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end('upstream error');
    });
    upstreamReq.write(raw);
    upstreamReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`Diagnostic proxy on http://localhost:${PORT} -> ${UPSTREAM.href}`);
  console.log('Watching for cache_control on requests and cache_* tokens on responses.');
});
