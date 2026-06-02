import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveRoute } from './routes.js';
import { newRequestId, logReq, logRes, sessionIdFromUserId } from '../lib/log.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'routes.config.json'), 'utf8'));
const PORT = Number(process.env.ROUTER_PORT ?? 8788);
const DEFAULT_UPSTREAM = process.env.DEFAULT_UPSTREAM ?? 'anthropic';

const HOP_BY_HOP = ['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'];

// Recognized values for the `auth` field in routes.config.json. Anything else
// is a config typo and the router refuses to start rather than silently
// picking the wrong auth scheme at runtime.
export const KNOWN_AUTH_MODES = new Set(['passthrough', 'bearer', 'x-api-key']);

// Resolve an upstream's connection details. `passthrough` upstreams need no key —
// the client's own credentials (e.g. your Claude subscription token) are forwarded as-is.
function upstreamConn(name) {
  const u = config.upstreams[name];
  if (!u) throw new Error(`Unknown upstream '${name}' in config`);
  if (!KNOWN_AUTH_MODES.has(u.auth)) {
    throw new Error(`Unknown auth mode '${u.auth}' for upstream '${name}' (expected one of: ${[...KNOWN_AUTH_MODES].join(', ')})`);
  }
  const baseUrl = process.env[u.baseUrlEnv] || u.defaultBaseUrl;
  let key = null;
  if (u.auth !== 'passthrough') {
    key = process.env[u.keyEnv];
    if (!key) throw new Error(`Missing API key env ${u.keyEnv} for upstream '${name}'`);
  }
  return { url: new URL(baseUrl), key, auth: u.auth };
}

// passthrough: leave the client's credentials intact. bearer/x-api-key: replace them.
export function applyAuth(headers, conn) {
  if (conn.auth === 'passthrough') return;
  delete headers['x-api-key'];
  delete headers.authorization;
  if (conn.auth === 'bearer') headers.authorization = `Bearer ${conn.key}`;
  else headers['x-api-key'] = conn.key;
}

export function forward(req, res, conn, outBody, { id, t0, session }) {
  const headers = { ...req.headers };
  for (const h of HOP_BY_HOP) delete headers[h];
  headers.host = conn.url.host;
  headers['content-length'] = String(outBody.length);
  applyAuth(headers, conn);

  const upstreamPath = conn.url.pathname.replace(/\/$/, '') + req.url;
  // https.request() accepts the `protocol` option and handles both http:// and
  // https:// upstreams; http.request() rejects 'https:' outright. Use the same
  // request module for both protocols.
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
      // Log the RES line on response end. usage is null because the router
      // pipes SSE bytes through without buffering (see spec "Known gap").
      upstreamRes.on('end', () => {
        logRes(id, {
          upstream: conn.url.host,
          status: upstreamRes.statusCode ?? 502,
          durationMs: Date.now() - t0,
          usage: null,
          session,
        });
      });
    }
  );
  upstreamReq.on('error', (err) => {
    console.error('[ROUTER UPSTREAM ERROR]', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error');
    // Emit a RES line for the failed request so it shows up in logs.
    logRes(id, {
      upstream: conn.url.host,
      status: 502,
      durationMs: Date.now() - t0,
      usage: null,
      session,
    });
  });
  upstreamReq.write(outBody);
  upstreamReq.end();
}

function fail(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

// Exported for tests; the server below wraps it. The handler reads the
// request body, makes the routing decision, emits REQ/RES log lines, and
// forwards to the chosen upstream.
export function handleRequest(req, res) {
  const chunks = [];
  req.on('error', (e) => console.error('[REQ ERROR]', e.message));
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const id = newRequestId();
    const t0 = Date.now();

    // Only POSTs with a JSON body carry a model to route on. Everything else
    // (GET /v1/models on startup, bodyless calls) rides the default upstream untouched.
    let conn, outBody, route, parsedBody;
    if (req.method === 'POST' && raw.length) {
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail(res, 400, 'router: body is not JSON');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return fail(res, 400, 'router: body must be a JSON object');
      }
      parsedBody = body;
      route = resolveRoute(body.model, config.routes);
      if (route) {
        try {
          conn = upstreamConn(route.upstream);
        } catch (err) {
          return fail(res, 500, `router: ${err.message}`);
        }
        body.model = route.realModel;
        outBody = Buffer.from(JSON.stringify(body), 'utf8');
      } else {
        // Unmapped model → ride the default upstream untouched. For a Claude
        // subscription this forwards your own credential straight to Anthropic.
        try {
          conn = upstreamConn(DEFAULT_UPSTREAM);
        } catch (err) {
          return fail(res, 500, `router: ${err.message}`);
        }
        outBody = raw;
      }
    } else {
      try {
        conn = upstreamConn(DEFAULT_UPSTREAM);
      } catch (err) {
        return fail(res, 500, `router: ${err.message}`);
      }
      outBody = raw;
    }

    const session = sessionIdFromUserId(parsedBody?.metadata?.user_id);
    logReq(id, {
      method: req.method,
      url: req.url,
      model: parsedBody?.model,
      route: route?.realModel,
      upstream: conn.url.host,
      user: parsedBody?.metadata?.user_id,
      session,
    });

    forward(req, res, conn, outBody, { id, t0, session });
  });
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Router on http://localhost:${PORT}`);
  console.log(`Mapped routes: ${Object.keys(config.routes).join(', ') || '(none)'}`);
  console.log(`Everything else → ${DEFAULT_UPSTREAM} upstream (passthrough)`);
  // Yellow banner confirms colorized log code is loaded. If you don't see
  // this in yellow, you're running the wrong code (or a version without
  // color support).
  let headSha = 'unknown';
  try {
    headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
  } catch {
    // Not running from a git checkout; the banner is best-effort.
  }
  console.log(`\x1b[33m[router] log color enabled (commit HEAD = ${headSha})\x1b[0m`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
