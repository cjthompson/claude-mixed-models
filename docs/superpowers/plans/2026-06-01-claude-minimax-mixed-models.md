# Claude Code + MiniMax Mixed-Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Claude Code with both Anthropic and MiniMax models in one session, routing role-specialized subagents to the cheaper-or-stronger provider per task, without losing prompt caching.

**Architecture:** A small zero-dependency Node reverse proxy sits between Claude Code and the upstream APIs. Claude Code points `ANTHROPIC_BASE_URL` at the proxy. The proxy reads the `model` field on each request, looks it up in a route table, rewrites it to the upstream's real model ID, and forwards to the correct provider with that provider's own API key. MiniMax exposes an Anthropic-compatible endpoint (`https://api.minimax.io/anthropic`) that supports the **identical** `cache_control: {type: "ephemeral"}` format, so caching is preserved by passing those breakpoints through untouched. Subagents select a provider purely by their `model:` frontmatter (an alias the router resolves). We build the router ourselves rather than adopting an off-the-shelf one so the schema is fully under our control and certain.

**Tech Stack:** Node.js (built-in `http`/`https`/`node:test` only — zero npm dependencies), Claude Code subagents (`.claude/agents/*.md`), MiniMax Anthropic-compatible API, Anthropic API.

**Phasing & the caching gate:** Phase 0 is a throwaway diagnostic that answers one question — *does Claude Code emit `cache_control` for a non-Claude model name?* Its result is informational: the router design already neutralizes the risk by giving MiniMax routes Claude-prefixed aliases, but Phase 0 tells us whether that alias is load-bearing or just belt-and-suspenders. Phases 1–2 build the real system. Phase 3 (Agent Teams / mechanism #5) is scoped out as future work.

**Prerequisites the implementer must have:**
- A MiniMax API key (env `MINIMAX_API_KEY`). Endpoint: `https://api.minimax.io/anthropic` (use `api.minimaxi.com` for China).
- An Anthropic API key (env `ANTHROPIC_API_KEY`).
- Claude Code installed and runnable as `claude`.
- Node.js 20+ (`node --version`).

**Background facts verified during design (2026-06-01):**
- MiniMax's Anthropic-compatible endpoint supports explicit prompt caching with the same `cache_control` format, `tools → system → messages` prefix hierarchy, 5-min TTL with refresh-on-hit, max 4 breakpoints/request. Cache write ≈1.25× input, cache read ≈0.1× input. Source: https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache
- Caching is most often lost client-side, when a client refuses to *send* `cache_control` for model names lacking "claude" (an `is_claude` gate). Source: https://github.com/NousResearch/hermes-agent/issues/17332
- MiniMax models supported by the cached endpoint include `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`, `MiniMax-M2.1`, `MiniMax-M2` / `M2-Stable`. Confirm the exact ID you intend to use is live before Phase 1.

---

## File Structure

```
claude-mixed-models/
├── .env.example                       # documents required env vars
├── .gitignore
├── README.md
├── package.json                       # {"type":"module"}, scripts only, no deps
├── docs/superpowers/plans/2026-06-01-claude-minimax-mixed-models.md
├── proxy/                             # Phase 0 throwaway diagnostic
│   ├── inspect.js                     # pure: hasCacheControl(), extractUsageFromSse()
│   ├── inspect.test.js
│   └── server.js                      # transparent logging pass-through to MiniMax
├── router/                           # Phase 1 real router
│   ├── routes.js                      # pure: resolveRoute(model, table)
│   ├── routes.test.js
│   ├── server.js                      # multi-upstream reverse proxy
│   └── routes.config.json             # model/alias -> upstream mapping
├── .claude/agents/                   # Phase 2 role split
│   ├── bulk-coder.md                  # routed to MiniMax via alias
│   └── reviewer.md                    # routed to Anthropic Opus
└── scripts/
    ├── run-diagnostic.sh              # launches Claude Code at the proxy
    └── run-router.sh                  # launches Claude Code at the router
```

Responsibilities:
- `proxy/inspect.js` & `router/routes.js` hold all logic worth unit-testing as pure functions. Servers are thin plumbing, validated by the live runs.
- `routes.config.json` is the single source of truth for which model name goes to which provider. Adding a provider/alias is a one-line config change, no code edit.
- Agent files carry zero routing logic — they only name a model alias.

---

## Phase 0 — Caching Diagnostic (the gate)

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-mixed-models",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "proxy": "node proxy/server.js",
    "router": "node router/server.js"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```gitignore
node_modules/
.env
*.log
proxy-capture/
```

- [ ] **Step 3: Create `.env.example`**

```bash
# Copy to .env and fill in. .env is gitignored.
ANTHROPIC_API_KEY=sk-ant-...
MINIMAX_API_KEY=...
# Optional overrides
PROXY_PORT=8787
ROUTER_PORT=8788
MINIMAX_BASE_URL=https://api.minimax.io/anthropic
ANTHROPIC_BASE_URL_UPSTREAM=https://api.anthropic.com
```

- [ ] **Step 4: Create `README.md`**

```markdown
# claude-mixed-models

Run Claude Code with both Anthropic and MiniMax models via a tiny local router.

- `proxy/` — Phase 0 throwaway diagnostic that checks whether prompt caching survives to MiniMax.
- `router/` — the real multi-upstream router. Point Claude Code's `ANTHROPIC_BASE_URL` at it.
- `.claude/agents/` — role-split subagents that pick a provider by model alias.

## Quick start
1. `cp .env.example .env` and fill in keys.
2. Phase 0: `npm run proxy` then in another shell `scripts/run-diagnostic.sh`. Read `proxy/server.js` log output.
3. Phase 1+: `npm run router` then `scripts/run-router.sh`.

See `docs/superpowers/plans/` for the full plan.
```

- [ ] **Step 5: Commit**

```bash
cd "$HOME/dev/personal/claude-mixed-models"
git add package.json .gitignore .env.example README.md docs/
git commit -m "chore: scaffold claude-mixed-models project"
```

---

### Task 2: Request/response inspection helpers (pure functions, TDD)

**Files:**
- Create: `proxy/inspect.js`
- Test: `proxy/inspect.test.js`

- [ ] **Step 1: Write the failing tests**

`proxy/inspect.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasCacheControl, extractUsageFromSse } from './inspect.js';

test('hasCacheControl: detects cache_control in system blocks', () => {
  const body = {
    model: 'x',
    system: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
    messages: [],
  };
  assert.equal(hasCacheControl(body), true);
});

test('hasCacheControl: detects cache_control in tools', () => {
  const body = { tools: [{ name: 't', cache_control: { type: 'ephemeral' } }], messages: [] };
  assert.equal(hasCacheControl(body), true);
});

test('hasCacheControl: false when no breakpoints anywhere', () => {
  const body = { system: 'plain string', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(hasCacheControl(body), false);
});

test('extractUsageFromSse: pulls cache token counts from message_start', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":1234,"cache_read_input_tokens":0}}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const usage = extractUsageFromSse(sse);
  assert.equal(usage.cache_creation_input_tokens, 1234);
  assert.equal(usage.cache_read_input_tokens, 0);
});

test('extractUsageFromSse: returns null when no usage present', () => {
  assert.equal(extractUsageFromSse('event: ping\ndata: {}\n\n'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './inspect.js'`.

- [ ] **Step 3: Write minimal implementation**

`proxy/inspect.js`:

```javascript
// Deep-scan an Anthropic request body for any cache_control breakpoint.
export function hasCacheControl(body) {
  let found = false;
  const walk = (node) => {
    if (found || node == null || typeof node !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(node, 'cache_control')) {
      found = true;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else {
      for (const key of Object.keys(node)) walk(node[key]);
    }
  };
  walk(body);
  return found;
}

// Anthropic streams the prompt-side usage (including cache_*_input_tokens) in the
// message_start event. Scan SSE text for the first such usage object.
export function extractUsageFromSse(sseText) {
  for (const line of sseText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    const usage = obj?.message?.usage ?? obj?.usage;
    if (usage && typeof usage === 'object') return usage;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add proxy/inspect.js proxy/inspect.test.js
git commit -m "feat(proxy): add cache_control and SSE usage inspection helpers"
```

---

### Task 3: Transparent logging proxy

**Files:**
- Create: `proxy/server.js`
- Create: `scripts/run-diagnostic.sh`

- [ ] **Step 1: Write the proxy**

`proxy/server.js`. A dumb pass-through — it must NOT add or strip `cache_control`, so it forwards the raw request bytes unchanged. It only observes.

```javascript
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
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);

    // Observe the request (parse a copy; forward the original bytes untouched).
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
    delete headers['content-length'];

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
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        const respChunks = [];
        upstreamRes.on('data', (c) => {
          respChunks.push(c);
          res.write(c); // tee: client gets the stream live
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
```

- [ ] **Step 2: Write the launch script**

`scripts/run-diagnostic.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Loads .env, points Claude Code's MAIN model at MiniMax through the diagnostic proxy.
# This forces the exact condition under test: Claude Code emitting to a non-Claude model name.
set -a; source "$(dirname "$0")/../.env"; set +a

export ANTHROPIC_BASE_URL="http://localhost:${PROXY_PORT:-8787}"
export ANTHROPIC_AUTH_TOKEN="${MINIMAX_API_KEY}"   # ignored by proxy, but Claude Code requires a token
export ANTHROPIC_MODEL="${MINIMAX_MODEL:-MiniMax-M2.5}"

echo "Launching Claude Code -> proxy -> MiniMax as model=${ANTHROPIC_MODEL}"
claude
```

- [ ] **Step 3: Make the script executable and commit**

```bash
chmod +x scripts/run-diagnostic.sh
git add proxy/server.js scripts/run-diagnostic.sh
git commit -m "feat(proxy): transparent logging pass-through to MiniMax"
```

---

### Task 4: Run the diagnostic and record the verdict

**Files:**
- Create: `docs/superpowers/plans/phase0-result.md`

- [ ] **Step 1: Start the proxy**

Run (terminal A): `npm run proxy`
Expected: `Diagnostic proxy on http://localhost:8787 -> https://api.minimax.io/anthropic`

- [ ] **Step 2: Drive two cache-eligible turns**

Run (terminal B): `scripts/run-diagnostic.sh`
Inside the Claude Code session, send two prompts back-to-back (within 5 minutes) that share the system prompt + tools prefix, e.g. ask a question, then ask a trivial follow-up. The shared prefix is what a second call can read from cache.

- [ ] **Step 3: Read the proxy log and classify the outcome**

Look at terminal A. Match against this table:

| Log shows | Meaning | Consequence for the build |
|---|---|---|
| `cache_control_present=true` **and** a later `[RES] ... cache_read>0` | Caching works natively to MiniMax | Aliases are belt-and-suspenders; keep them anyway, they cost nothing |
| `cache_control_present=false` | Claude Code gates emit on the model name (`is_claude`) | The Claude-prefixed alias in Phase 1 is **load-bearing** — do not skip it |
| `cache_control_present=true` but `cache_read` always `0`/`n/a` | MiniMax-side or field-name issue | Re-check MiniMax model ID and that `usage` field names match; investigate before Phase 1 |

- [ ] **Step 4: Record the verdict**

Write `docs/superpowers/plans/phase0-result.md` with: the date, the model ID used, the literal log lines for `[REQ]` and `[RES]`, and which row of the table you landed on. One paragraph. This is the input to the Phase 1 alias decision.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/phase0-result.md
git commit -m "docs: record Phase 0 caching diagnostic result"
```

---

## Phase 1 — The Router

### Task 5: Route resolution (pure function, TDD)

**Files:**
- Create: `router/routes.js`
- Test: `router/routes.test.js`
- Create: `router/routes.config.json`

- [ ] **Step 1: Write the failing tests**

`router/routes.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute } from './routes.js';

const table = {
  'claude-opus-4-8': { upstream: 'anthropic', realModel: 'claude-opus-4-8' },
  'claude-sonnet-4-6': { upstream: 'anthropic', realModel: 'claude-sonnet-4-6' },
  // Claude-prefixed ALIAS that resolves to a MiniMax model — the caching alias trick.
  'claude-minimax-m2': { upstream: 'minimax', realModel: 'MiniMax-M2.5' },
};

test('resolveRoute: maps an Anthropic model to the anthropic upstream unchanged', () => {
  assert.deepEqual(resolveRoute('claude-opus-4-8', table), {
    upstream: 'anthropic', realModel: 'claude-opus-4-8',
  });
});

test('resolveRoute: maps a claude-prefixed alias to the minimax upstream with rewritten model', () => {
  assert.deepEqual(resolveRoute('claude-minimax-m2', table), {
    upstream: 'minimax', realModel: 'MiniMax-M2.5',
  });
});

test('resolveRoute: returns null for an unknown model', () => {
  assert.equal(resolveRoute('gpt-9', table), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './routes.js'`.

- [ ] **Step 3: Write minimal implementation**

`router/routes.js`:

```javascript
// Resolve an inbound model name to an upstream + the upstream's real model id.
// Returns null when the model isn't in the table (caller should 400).
export function resolveRoute(model, table) {
  const route = table[model];
  if (!route) return null;
  return { upstream: route.upstream, realModel: route.realModel };
}
```

- [ ] **Step 4: Create the route config**

`router/routes.config.json`. The `upstreams` block holds connection details (keys come from env, never checked in). The `routes` block maps inbound model names/aliases to an upstream + real model.

```json
{
  "upstreams": {
    "anthropic": { "baseUrlEnv": "ANTHROPIC_BASE_URL_UPSTREAM", "defaultBaseUrl": "https://api.anthropic.com", "keyEnv": "ANTHROPIC_API_KEY", "auth": "x-api-key" },
    "minimax": { "baseUrlEnv": "MINIMAX_BASE_URL", "defaultBaseUrl": "https://api.minimax.io/anthropic", "keyEnv": "MINIMAX_API_KEY", "auth": "bearer" }
  },
  "routes": {
    "claude-opus-4-8": { "upstream": "anthropic", "realModel": "claude-opus-4-8" },
    "claude-sonnet-4-6": { "upstream": "anthropic", "realModel": "claude-sonnet-4-6" },
    "claude-haiku-4-5": { "upstream": "anthropic", "realModel": "claude-haiku-4-5-20251001" },
    "claude-minimax-m2": { "upstream": "minimax", "realModel": "MiniMax-M2.5" }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `routes` and `inspect` tests green.

- [ ] **Step 6: Commit**

```bash
git add router/routes.js router/routes.test.js router/routes.config.json
git commit -m "feat(router): route resolution and config table"
```

---

### Task 6: The router server

**Files:**
- Create: `router/server.js`
- Create: `scripts/run-router.sh`

- [ ] **Step 1: Write the router server**

`router/server.js`. Same streaming pass-through shape as the diagnostic proxy, extended to: pick an upstream from the route table, rewrite the `model` field, inject that upstream's auth, and forward. `cache_control` is passed through untouched.

```javascript
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

    body.model = route.realModel; // rewrite alias -> real upstream model
    const outBody = Buffer.from(JSON.stringify(body), 'utf8');
    console.log(`[ROUTER] ${body.model ? '' : ''}${route.upstream} <- alias resolved -> ${route.realModel}`);

    const headers = { ...req.headers };
    headers.host = conn.url.host;
    delete headers['content-length'];
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
```

- [ ] **Step 2: Write the launch script**

`scripts/run-router.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
set -a; source "$(dirname "$0")/../.env"; set +a

export ANTHROPIC_BASE_URL="http://localhost:${ROUTER_PORT:-8788}"
export ANTHROPIC_AUTH_TOKEN="router-local"          # router injects real per-upstream keys
export ANTHROPIC_MODEL="${MAIN_MODEL:-claude-opus-4-8}"  # main loop stays on Anthropic

echo "Launching Claude Code -> router (main model=${ANTHROPIC_MODEL})"
claude
```

- [ ] **Step 3: Make executable and commit**

```bash
chmod +x scripts/run-router.sh
git add router/server.js scripts/run-router.sh
git commit -m "feat(router): multi-upstream reverse proxy with model rewriting"
```

---

### Task 7: Verify routing + caching end-to-end through the router

- [ ] **Step 1: Start the router**

Run (terminal A): `npm run router`
Expected: `Router on http://localhost:8788` and a `Routes:` line listing the four model names.

- [ ] **Step 2: Sanity-check the Anthropic path**

Run (terminal B): `scripts/run-router.sh`. Ask any question. The session should answer normally (main model `claude-opus-4-8` → anthropic upstream). Terminal A logs `anthropic ... -> claude-opus-4-8`.

- [ ] **Step 3: Sanity-check the MiniMax alias path**

Inside the session, run `/model claude-minimax-m2` (or set `MAIN_MODEL=claude-minimax-m2` and relaunch). Ask a question, then a follow-up. Terminal A logs `minimax ... -> MiniMax-M2.5` for both. The session should answer normally — confirming the alias resolves and MiniMax serves it.

- [ ] **Step 4: Confirm caching survived (if Phase 0 said it was at risk)**

If Phase 0 landed on the `cache_control_present=false` row, confirm the alias fixed it: temporarily add the diagnostic proxy's response logging, or briefly point the router's minimax upstream at `http://localhost:8787` (the diagnostic proxy) and watch for `cache_read>0` on the second MiniMax turn. If Phase 0 was green, skip this step.

- [ ] **Step 5: Commit any config tweaks**

```bash
git add -A
git commit -m "test(router): verify anthropic + minimax-alias routing end-to-end" --allow-empty
```

---

## Phase 2 — Role-Split Subagents (mechanism #4)

### Task 8: Define the role-split agents

**Files:**
- Create: `.claude/agents/bulk-coder.md`
- Create: `.claude/agents/reviewer.md`

- [ ] **Step 1: Create the MiniMax bulk-coder agent**

`.claude/agents/bulk-coder.md`. Note `model:` is the Claude-prefixed alias — the router sends it to MiniMax. This agent is scoped to forgiving, high-volume work where the cheaper model shines and mistakes are cheap to catch.

```markdown
---
name: bulk-coder
description: Use for high-volume, low-judgment code generation — scaffolding, boilerplate, repetitive edits across many files, first-draft implementations from a precise spec. Not for architecture, security-sensitive code, or final review.
model: claude-minimax-m2
tools: Read, Write, Edit, Glob, Grep, Bash
---

You generate code in bulk from precise specifications. You are dispatched for the
high-volume, low-judgment parts of a task: scaffolding, boilerplate, repetitive edits,
and first drafts from a clear spec.

Rules:
- Follow the spec literally. Do not redesign or add features (YAGNI).
- Match existing file conventions exactly — read a neighbouring file first.
- Make the smallest change that satisfies the spec. Leave architecture decisions to the caller.
- When the spec is ambiguous, state the ambiguity and pick the most conventional option; do not invent scope.
- Output only the changes requested. A reviewer agent will check your work.
```

- [ ] **Step 2: Create the Anthropic reviewer agent**

`.claude/agents/reviewer.md`. `model:` is a real Anthropic model — judgment work stays on Opus.

```markdown
---
name: reviewer
description: Use to review code for correctness, security, and design quality before it is accepted — especially code produced by the bulk-coder agent. Cross-model review: this runs on Anthropic while bulk generation runs on MiniMax.
model: claude-opus-4-8
tools: Read, Glob, Grep, Bash
---

You review code changes for correctness, security, and design quality. You are
deliberately a different model lineage from the agent that wrote the code, so your
job is to catch what a same-model review would miss.

Focus, in priority order:
1. Correctness — does it do what the spec says? Edge cases, off-by-ones, error paths.
2. Security — injection, secret handling, unsafe shell/SQL, auth gaps.
3. Convention — does it match the surrounding codebase?
4. Simplicity — is there a smaller, clearer version?

Report only high-confidence issues, each as: file:line, the problem, and the fix.
Do not rewrite the code yourself. If it's sound, say so plainly.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/bulk-coder.md .claude/agents/reviewer.md
git commit -m "feat(agents): role-split bulk-coder (MiniMax) and reviewer (Anthropic)"
```

---

### Task 9: Verify subagent provider routing

- [ ] **Step 1: Launch with the router running**

Terminal A: `npm run router`. Terminal B: `scripts/run-router.sh`.

- [ ] **Step 2: Dispatch the bulk-coder and watch the route**

In the session, ask Claude to "use the bulk-coder subagent to scaffold a trivial file." Watch terminal A: the subagent's requests must log `minimax ... -> MiniMax-M2.5`. This is the proof that subagent provider selection works.

- [ ] **Step 3: Dispatch the reviewer and watch the route**

Ask Claude to "use the reviewer subagent to review that file." Terminal A must log `anthropic ... -> claude-opus-4-8` for those requests.

- [ ] **Step 4: Record the result**

Append a short "Phase 2 verified" note to `docs/superpowers/plans/phase0-result.md` (rename it mentally to a running results log) with the literal router log lines proving each agent hit its intended provider.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(agents): verify subagent provider routing via router logs" --allow-empty
```

---

## Out of Scope (future work)

- **Mechanism #5 — Agent Teams with mixed models.** The router built here already makes mixed-provider teams *possible* (teammates select providers by alias exactly like subagents). What's unbuilt is validating that a non-Claude teammate reliably follows the `SendMessage` team-coordination protocol. Defer until #4 is proven in daily use; it gets its own spec.
- **Rule-based routing** (route by task class — background/long-context/reasoning — rather than explicit alias). The config table is the natural extension point; add when a concrete need appears.
- **Cost/usage accounting** across providers. The diagnostic proxy already extracts `usage`; promoting that into the router as a metrics log is a small, additive task when wanted.

---

## Self-Review Notes

- **Spec coverage:** Mechanism #4 (per-subagent provider) → Tasks 5–9. Caching verification (the user's explicit priority) → Phase 0 Tasks 1–4, re-confirmed in Task 7 Step 4. The alias trick (the fix if caching is gated) → Task 5 config + Task 6 rewrite. Mechanism #5 explicitly deferred.
- **No placeholders:** every code/config/script step contains complete, runnable content.
- **Type/name consistency:** `hasCacheControl` / `extractUsageFromSse` defined in Task 2 and used in Task 3; `resolveRoute(model, table)` defined in Task 5 and used in Task 6; route names (`claude-opus-4-8`, `claude-minimax-m2`) are identical across `routes.config.json`, the agent `model:` fields, and the launch scripts.
- **Known soft spot to verify at execution time:** the exact MiniMax model ID (`MiniMax-M2.5`) and that Claude Code's `/model` accepts an arbitrary custom alias name. If `/model` rejects unknown names, use the `MAIN_MODEL=` env override in the launch script instead (already provided).
