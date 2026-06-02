import http from 'node:http';
import https from 'node:https';
import { hasCacheControl, extractUsageFromSse } from './inspect.js';

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

    if (raw.length) {
      try {
        const body = JSON.parse(raw.toString('utf8'));
        console.log(
          `\n[REQ] ${req.method} ${req.url} model=${body.model} ` +
          `cache_control_present=${hasCacheControl(body)}`
        );
      } catch {
        console.log(`\n[REQ] ${req.method} ${req.url} (non-JSON body, ${raw.length}B)`);
      }
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
          if (usage) {
            console.log(
              `[RES] status=${upstreamRes.statusCode} ` +
              `cache_write=${usage.cache_creation_input_tokens ?? 'n/a'} ` +
              `cache_read=${usage.cache_read_input_tokens ?? 'n/a'} ` +
              `input=${usage.input_tokens ?? 'n/a'}`
            );
          } else {
            console.log(`[RES] status=${upstreamRes.statusCode} (no usage found)`);
          }
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
