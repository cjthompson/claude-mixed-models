import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveRoute } from './routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'routes.config.json'), 'utf8'));
const PORT = Number(process.env.ROUTER_PORT ?? 8788);

function upstreamConn(name) {
  const u = config.upstreams[name];
  if (!u) throw new Error(`Unknown upstream '${name}' in config`);
  const baseUrl = process.env[u.baseUrlEnv] || u.defaultBaseUrl;
  const key = process.env[u.keyEnv];
  if (!key) throw new Error(`Missing API key env ${u.keyEnv} for upstream '${name}'`);
  return { url: new URL(baseUrl), key, auth: u.auth };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('error', (e) => console.error('[REQ ERROR]', e.message));
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'router: body is not JSON' }));
      return;
    }

    const route = resolveRoute(body.model, config.routes);
    if (!route) {
      console.error(`[ROUTER] no route for model='${body.model}'`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `router: no route for model '${body.model}'` }));
      return;
    }

    let conn;
    try {
      conn = upstreamConn(route.upstream);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `router: ${err.message}` }));
      return;
    }

    body.model = route.realModel;
    const outBody = Buffer.from(JSON.stringify(body), 'utf8');
    console.log(`[ROUTER] ${route.upstream} <- alias resolved -> ${route.realModel}`);

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
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
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
  });
});

server.listen(PORT, () => {
  console.log(`Router on http://localhost:${PORT}`);
  console.log(`Routes: ${Object.keys(config.routes).join(', ')}`);
});
