import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveRoute } from './routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'routes.config.json'), 'utf8'));
const PORT = Number(process.env.ROUTER_PORT ?? 8788);
const DEFAULT_UPSTREAM = process.env.DEFAULT_UPSTREAM ?? 'anthropic';

const HOP_BY_HOP = ['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'];

function upstreamConn(name) {
  const u = config.upstreams[name];
  if (!u) throw new Error(`Unknown upstream '${name}' in config`);
  const baseUrl = process.env[u.baseUrlEnv] || u.defaultBaseUrl;
  const key = process.env[u.keyEnv];
  if (!key) throw new Error(`Missing API key env ${u.keyEnv} for upstream '${name}'`);
  return { url: new URL(baseUrl), key, auth: u.auth };
}

function forward(req, res, conn, outBody) {
  const headers = { ...req.headers };
  headers.host = conn.url.host;
  headers['content-length'] = String(outBody.length);
  delete headers['x-api-key'];
  delete headers.authorization;
  if (conn.auth === 'bearer') headers.authorization = `Bearer ${conn.key}`;
  else headers['x-api-key'] = conn.key;

  const upstreamPath = conn.url.pathname.replace(/\/$/, '') + req.url;
  const upstreamReq = https.request(
    {
      protocol: conn.url.protocol,
      hostname: conn.url.hostname,
      port: conn.url.port || 443,
      method: req.method,
      path: upstreamPath,
      headers,
    },
    (upstreamRes) => {
      const safeHeaders = { ...upstreamRes.headers };
      for (const h of HOP_BY_HOP) delete safeHeaders[h];
      res.writeHead(upstreamRes.statusCode ?? 502, safeHeaders);
      upstreamRes.pipe(res);
    }
  );
  upstreamReq.on('error', (err) => {
    console.error('[ROUTER UPSTREAM ERROR]', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error');
  });
  upstreamReq.write(outBody);
  upstreamReq.end();
}

function fail(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('error', (e) => console.error('[REQ ERROR]', e.message));
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);

    // Bodyless or non-POST requests (e.g. GET /v1/models on startup) carry no model
    // to route on. Forward them unchanged to the default upstream.
    if (req.method !== 'POST' || raw.length === 0) {
      let conn;
      try {
        conn = upstreamConn(DEFAULT_UPSTREAM);
      } catch (err) {
        return fail(res, 500, `router: ${err.message}`);
      }
      console.log(`[ROUTER] ${req.method} ${req.url} -> default upstream ${DEFAULT_UPSTREAM}`);
      return forward(req, res, conn, raw);
    }

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return fail(res, 400, 'router: body is not JSON');
    }

    const route = resolveRoute(body.model, config.routes);
    if (!route) {
      console.error(`[ROUTER] no route for model='${body.model}'`);
      return fail(res, 400, `router: no route for model '${body.model}'`);
    }

    let conn;
    try {
      conn = upstreamConn(route.upstream);
    } catch (err) {
      return fail(res, 500, `router: ${err.message}`);
    }

    body.model = route.realModel;
    const outBody = Buffer.from(JSON.stringify(body), 'utf8');
    console.log(`[ROUTER] ${body.model} via ${route.upstream} (alias resolved)`);
    forward(req, res, conn, outBody);
  });
});

server.listen(PORT, () => {
  console.log(`Router on http://localhost:${PORT}`);
  console.log(`Routes: ${Object.keys(config.routes).join(', ')}`);
});
