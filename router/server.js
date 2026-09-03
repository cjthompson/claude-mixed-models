import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveRoute } from './routes.js';
import { newRequestId, logReq, logRes, sessionIdFromUserId } from '../lib/log.js';
import { SseLineScanner } from '../lib/sse.js';
import { normalizeUsage } from '../lib/usage.js';
import { logEvent } from '../lib/event.js';
import { createSampler } from './instrumentation.js';
import { pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.ROUTES_CONFIG ?? join(here, 'routes.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const PORT = Number(process.env.ROUTER_PORT ?? 8788);
const DEFAULT_UPSTREAM = process.env.DEFAULT_UPSTREAM ?? 'anthropic';

const HOP_BY_HOP = ['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'];

let onResponse = null;
if (process.env.SAMPLE_SSE) onResponse = createSampler();

// Set by installShutdown() once a SIGTERM drain begins. Read by forward()'s
// empty-response detector so a connection torn down by our own shutdown
// isn't misreported as an upstream failure. Test-only setter below.
let routerShuttingDown = false;
export function __setRouterShuttingDownForTest(v) { routerShuttingDown = v; }

// Recognized values for the `auth` field in routes.config.json. Anything else
// is a config typo and the router refuses to start rather than silently
// picking the wrong auth scheme at runtime.
export const KNOWN_AUTH_MODES = new Set(['passthrough', 'bearer', 'x-api-key']);

// forward() picks http.request or https.request based on this. Exported so
// tests can exercise the validation directly with an arbitrary URL instead
// of mutating the module-level config.
export function assertSupportedProtocol(url, name) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol '${url.protocol}' for upstream '${name}' (expected http: or https:)`);
  }
}

// Hosts that never leave the machine (or the same docker/VM network
// namespace), so a cleartext credential sent to one of them isn't exposed
// on the wire in any meaningful sense. Anything else reached over `http:`
// is a real cleartext-credential risk.
function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

// Upstream names we've already warned about, so a busy router logs the
// cleartext-credential risk once at config-resolution time (per upstream)
// rather than once per request.
const warnedInsecureUpstreams = new Set();

// Warn (without ever logging the secret itself) when a keyed upstream is
// reachable only over `http:` to a non-loopback host — the bearer/API key
// applyAuth() attaches would cross the network in cleartext. Exported so
// tests can exercise it directly with an arbitrary URL/auth combination.
export function warnIfInsecureUpstream(url, name, auth) {
  if (auth === 'passthrough') return;
  if (url.protocol !== 'http:') return;
  if (isLoopbackHost(url.hostname)) return;
  if (warnedInsecureUpstreams.has(name)) return;
  warnedInsecureUpstreams.add(name);
  console.error(
    `[router] WARNING: upstream '${name}' is configured with http: to a non-loopback host (${url.hostname}). ` +
    `Its API key will be sent in cleartext. Use https: unless this upstream is trusted and local-only.`
  );
}

// Resolve an upstream's connection details. `passthrough` upstreams need no key —
// the client's own credentials (e.g. your Claude subscription token) are forwarded as-is.
function upstreamConn(name) {
  const u = config.upstreams[name];
  if (!u) throw new Error(`Unknown upstream '${name}' in config`);
  if (!KNOWN_AUTH_MODES.has(u.auth)) {
    throw new Error(`Unknown auth mode '${u.auth}' for upstream '${name}' (expected one of: ${[...KNOWN_AUTH_MODES].join(', ')})`);
  }
  const baseUrl = process.env[u.baseUrlEnv] || u.defaultBaseUrl;
  const url = new URL(baseUrl);
  assertSupportedProtocol(url, name);
  warnIfInsecureUpstream(url, name, u.auth);
  let key = null;
  if (u.auth !== 'passthrough') {
    key = process.env[u.keyEnv];
    if (!key) throw new Error(`Missing API key env ${u.keyEnv} for upstream '${name}'`);
  }
  return { url, key, auth: u.auth };
}

// passthrough: leave the client's credentials intact. bearer/x-api-key: replace them.
export function applyAuth(headers, conn) {
  if (conn.auth === 'passthrough') return;
  delete headers['x-api-key'];
  delete headers.authorization;
  if (conn.auth === 'bearer') headers.authorization = `Bearer ${conn.key}`;
  else headers['x-api-key'] = conn.key;
}

// Upstream-keyed request-body shims. Anthropic-built-in server tools
// (web_fetch, web_search, code_execution, bash, text_editor, memory) are
// advertised with a `type: "web_fetch_20250924"`-style discriminator in
// the `tools[]` array, and historically without a client-side
// `input_schema`. Compatible providers (e.g. the MiniMax Anthropic-shaped
// endpoint) require every tool entry to carry an `input_schema` and reject
// the request with "function name or parameters is empty" when a server
// tool arrives without one. Inject a permissive `input_schema` for any
// entry that lacks one; the upstream ignores the schema's contents for
// server tools (the model never sees the JSON schema — the platform
// dispatches the tool). The shim is a no-op for passthrough/Anthropic so
// native Anthropic traffic is untouched.
export function applyToolCompat(body, upstreamName) {
  if (upstreamName !== 'minimax') return;
  if (!body || !Array.isArray(body.tools)) return;
  let patched = 0;
  for (const tool of body.tools) {
    if (tool && typeof tool === 'object' && tool.input_schema == null) {
      tool.input_schema = { type: 'object', additionalProperties: true };
      patched++;
    }
  }
  if (patched > 0) console.error(`[tool-compat] injected input_schema on ${patched} tool entry/entries for ${upstreamName}`);
}

// Force thinking mode on for every MiniMax request. MiniMax-M3 defaults to
// `disabled` when the `thinking` field is omitted (unlike Claude, which the
// client already drives explicitly); M2.x models ignore the field entirely
// since thinking can't be disabled for them there. Overwrite whatever the
// client sent — including an explicit `disabled` — so MiniMax traffic always
// reasons, regardless of what the caller (built for Claude's own thinking
// knobs) put in the request. No-op for passthrough/Anthropic upstreams.
export function applyThinkingCompat(body, upstreamName) {
  if (upstreamName !== 'minimax') return;
  if (!body || typeof body !== 'object') return;
  body.thinking = { type: 'adaptive' };
}

export function forward(req, res, conn, outBody, { id, t0, session, model, realModel, reqBody }) {
  const headers = { ...req.headers };
  for (const h of HOP_BY_HOP) delete headers[h];
  // Prevent upstream from gzip-encoding the response — the router reads the raw
  // bytes to extract usage tokens, and compressed SSE is unreadable as UTF-8.
  delete headers['accept-encoding'];
  headers.host = conn.url.host;
  headers['content-length'] = String(outBody.length);
  applyAuth(headers, conn);

  const upstreamPath = conn.url.pathname.replace(/\/$/, '') + req.url;
  // http.request() rejects a 'https:' protocol option outright, and
  // https.request() rejects 'http:' outright — each module only speaks its
  // own scheme. conn.url.protocol is validated at the upstreamConn()
  // boundary (assertSupportedProtocol) to be one of the two, so this picks
  // the matching transport rather than hardcoding one.
  const transport = conn.url.protocol === 'http:' ? http : https;
  // `done` is shared by every exit path (upstream end, upstream error, client
  // close). Exactly one of them may call logRes + res.end for a given request.
  let done = false;
  const finalize = (fields) => {
    if (done) return;
    done = true;
    logRes(id, fields);
    // Best-effort event sink. Fire-and-forget; errors are swallowed inside logEvent.
    logEvent({
      id,
      model: fields.model,
      real_model: fields.real_model,
      upstream: fields.upstream,
      status: fields.status,
      durationMs: fields.durationMs,
      sessionId: fields.session,
      input_tokens: fields.usage?.input_tokens ?? 0,
      output_tokens: fields.usage?.output_tokens ?? 0,
      cache_read_input_tokens: fields.usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: fields.usage?.cache_creation_input_tokens ?? 0,
      // The TTL split and thinking cost are dropped by the legacy flat
      // logEvent payload. Pass them through so the stats pipeline can
      // attribute the cache choice per model and surface Opus's hidden
      // thinking tokens.
      cache_5m_input_tokens: fields.usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      cache_1h_input_tokens: fields.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      thinking_tokens: fields.usage?.output_tokens_details?.thinking_tokens ?? 0,
    });
  };
  const upstreamReq = transport.request(
    {
      hostname: conn.url.hostname,
      port: conn.url.port || (conn.url.protocol === 'http:' ? 80 : 443),
      method: req.method,
      path: upstreamPath,
      headers,
    },
    (upstreamRes) => {
      // Track the upstream status so the client-disconnect path can log it.
      const upstreamStatus = upstreamRes.statusCode ?? 502;
      const safeHeaders = { ...upstreamRes.headers };
      for (const h of HOP_BY_HOP) delete safeHeaders[h];
      // For non-200 responses write the status immediately. For 200 responses
      // we defer writeHead to the first data chunk so an empty body (HTTP 200
      // with no bytes) can be detected and converted to 502 before any bytes
      // reach the client. All paths below guard on res.headersSent.
      if (upstreamStatus !== 200) {
        res.writeHead(upstreamStatus, safeHeaders);
      }
      const scanner = new SseLineScanner();
      let chunkCount = 0;
      const isEventStream = (upstreamRes.headers['content-type'] ?? '').includes('event-stream');
      const jsonChunks = [];   // buffered only for non-SSE responses (small error/sync bodies)
      upstreamRes.on('data', (c) => {
        chunkCount++;
        scanner.push(c);
        if (!isEventStream) jsonChunks.push(c);
        if (!res.headersSent) res.writeHead(upstreamStatus, safeHeaders);
        if (!res.writableEnded) res.write(c);
      });
      upstreamRes.on('end', () => {
        scanner.flush();
        if (upstreamStatus === 200 && chunkCount === 0) {
          // During a shutdown drain, a forced socket.destroy() on the
          // client connection tears down this upstream request too, which
          // Node can surface as 'end' firing with zero chunks — identical
          // to a genuine empty 200 from the upstream's point of view. Don't
          // blame the upstream for our own teardown.
          if (!routerShuttingDown) {
            console.error(`[UPSTREAM EMPTY RESPONSE] upstream=${conn.url.host} sent HTTP 200 with empty body`);
          }
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
          if (!res.writableEnded) res.end(JSON.stringify({ error: 'upstream returned empty response (HTTP 200)' }));
          finalize({
            upstream: conn.url.host,
            status: 502,
            durationMs: Date.now() - t0,
            usage: null,
            session,
            model,
            real_model: realModel,
          });
          return;
        }
        if (!res.headersSent) res.writeHead(upstreamStatus, safeHeaders);
        if (!res.writableEnded) res.end();
        // SSE is the common case; fall back to JSON for non-streaming
        // responses (e.g. a 400 from the upstream returned as application/json).
        // normalizeUsage flattens the nested cache_creation TTL split and
        // guarantees output_tokens_details is present (defaulting to 0) so
        // every downstream consumer sees a stable shape regardless of
        // which model produced the response.
        const jsonText = isEventStream ? null : Buffer.concat(jsonChunks).toString('utf8');
        const rawUsage = scanner.usage ?? parseJsonUsage(jsonText);
        const usage = normalizeUsage(rawUsage);
        if (upstreamStatus === 200) onResponse?.(model, id, jsonText, reqBody);
        finalize({
          upstream: conn.url.host,
          status: upstreamStatus,
          durationMs: Date.now() - t0,
          usage,
          session,
          model,
          real_model: realModel,
        });
      });
    }
  );
  // If the client goes away mid-stream, kill the upstream so we don't keep
  // paying for a response nobody is reading, and log a RES line for it.
  res.on('close', () => {
    if (done) return;
    upstreamReq.destroy();
    finalize({
      upstream: conn.url.host,
      status: 499,    // nginx convention for "client closed request"
      durationMs: Date.now() - t0,
      usage: null,
      session,
      model,
      real_model: realModel,
    });
  });
  upstreamReq.on('error', (err) => {
    console.error('[ROUTER UPSTREAM ERROR]', err.message);
    if (!res.headersSent) res.writeHead(502);
    if (!res.writableEnded) res.end('upstream error');
    // Emit a RES line for the failed request so it shows up in logs.
    finalize({
      upstream: conn.url.host,
      status: 502,
      durationMs: Date.now() - t0,
      usage: null,
      session,
      model,
      real_model: realModel,
    });
  });
  upstreamReq.write(outBody);
  upstreamReq.end();
}

// Fallback for non-SSE responses. Returns null on any parse failure or when
// the parsed body has no .usage field.
function parseJsonUsage(text) {
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    const usage = obj?.usage;
    return usage && typeof usage === 'object' ? usage : null;
  } catch {
    return null;
  }
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
    let originalModel = null;
    let realModel = null;
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
      // Capture the user-supplied alias before the route rewrites body.model.
      // This is what we want to record in the stats event so we can attribute
      // usage back to the alias the caller asked for.
      originalModel = body.model;
      route = resolveRoute(body.model, config.routes);
      if (route) {
        try {
          conn = upstreamConn(route.upstream);
        } catch (err) {
          return fail(res, 500, `router: ${err.message}`);
        }
        realModel = route.realModel;
        body.model = route.realModel;
        applyToolCompat(body, route.upstream);
        applyThinkingCompat(body, route.upstream);
        outBody = Buffer.from(JSON.stringify(body), 'utf8');
      } else {
        // Unmapped model → ride the default upstream untouched. For a Claude
        // subscription this forwards your own credential straight to Anthropic.
        try {
          conn = upstreamConn(DEFAULT_UPSTREAM);
        } catch (err) {
          return fail(res, 500, `router: ${err.message}`);
        }
        realModel = originalModel;
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
      model: parsedBody?.model,
      upstream: conn.url.host,
      session,
    });

    forward(req, res, conn, outBody, { id, t0, session, model: originalModel, realModel, reqBody: parsedBody });
  });
}

// Factory, not a top-level binding, so importing this module from a test
// does not start a listening server (which would keep node --test alive
// long after the assertions complete and hang the suite).
export function createServer() {
  return http.createServer(handleRequest);
}

// Wire graceful shutdown on SIGTERM and SIGINT through a single
// signal-aware state machine. The router stops accepting new connections,
// lets in-flight streaming responses finish, and only exits once every
// tracked client socket has closed. Whichever signal arrives first starts
// the drain; any subsequent signal — including a different one from the
// first (e.g. SIGTERM then SIGINT) — forces the remaining sockets closed
// and exits immediately. The log lines always name the signal that
// actually arrived rather than assuming SIGTERM.
//
// Exported for tests. The production bottom-of-module call passes the
// real `process.exit`; tests inject a stub so they don't kill the runner.
export function installShutdown(srv, { exit = process.exit } = {}) {
  // Track every client TCP socket the server accepts. Tracking sockets
  // (not ServerResponses) is intentional: a keep-alive client may be
  // idle between requests with no active response, but it's still an
  // open connection we shouldn't drop on its own.
  const openConnections = new Set();
  let shuttingDown = false;
  let exitCode = 0;

  srv.on('connection', (socket) => {
    openConnections.add(socket);
    socket.on('close', () => {
      openConnections.delete(socket);
      if (shuttingDown) {
        console.log(`[shutdown] connection closed (${openConnections.size} remaining)`);
        if (openConnections.size === 0) exit(exitCode);
      }
    });
  });

  // Test seam: driven directly by tests (and by the process signal
  // listeners below in production) so tests never need to emit a real
  // process signal to exercise the state machine.
  const onSignal = (signal) => {
    if (shuttingDown) {
      console.log(`[shutdown] received second signal (${signal}), forcing immediate shutdown (${openConnections.size} connection(s) still open)`);
      for (const s of openConnections) s.destroy();
      exit(exitCode);
      return;
    }
    shuttingDown = true;
    routerShuttingDown = true;
    console.log(`[shutdown] received ${signal}, beginning graceful shutdown (${openConnections.size} open connection(s))`);
    srv.close((err) => {
      if (err) {
        exitCode = 1;
        console.error('[shutdown] server.close error:', err.message);
      }
      if (openConnections.size === 0) exit(exitCode);
    });
  };

  const onSigterm = () => onSignal('SIGTERM');
  const onSigint = () => onSignal('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);

  return {
    openConnections,
    get shuttingDown() { return shuttingDown; },
    onSignal,
    // Test-only seam: detaches the two process-level listeners this call
    // installed. Production never calls this — the real process is meant
    // to keep exactly one SIGTERM/SIGINT listener pair for its lifetime.
    // Tests call installShutdown() repeatedly (once per test), and without
    // this, each call would leave its listeners on `process` permanently,
    // both accumulating (eventually tripping Node's MaxListeners warning)
    // and leaving stale onSignal closures live for the rest of the run —
    // including ones bound to an already-closed test server.
    uninstall() {
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
    },
  };
}

// Entry-point guard: only bind the port and wire SIGTERM when this module
// is the script Node was told to run (`node router/server.js`,
// `npm run router`). When tests `import './server.js'`, process.argv[1]
// points elsewhere and this block is skipped, so the test runner can
// exit cleanly without us holding a port open.
const isEntry = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntry) {
  const server = createServer();
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
  installShutdown(server);
}
