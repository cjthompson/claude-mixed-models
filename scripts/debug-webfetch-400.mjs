// Diagnostic: drive the running router with synthetic Messages bodies to
// identify which Anthropic built-in server-tool `type` values trigger
// MiniMax's 400. Sends one variant per known type and prints upstream
// status + body for each.
//
// Usage:
//   ROUTER_URL=http://localhost:8788 node scripts/debug-webfetch-400.mjs
// Or with the default:
//   node scripts/debug-webfetch-400.mjs
//
// Exit code:
//   0 if the baseline (no tools) returned 200.
//   1 otherwise.

import http from 'node:http';

const ROUTER_URL = process.env.ROUTER_URL ?? 'http://localhost:8788';
const ROUTER_PATH = process.env.ROUTER_PATH ?? '/v1/messages?beta=true';
const BODY_PREVIEW_BYTES = 4096;

// Anthropic built-in server-tool `type` values seen in recent Claude API
// releases. Each is tested in its bare server-tool shape (just `type` and
// `name`) — the same shape Claude Code sends. If MiniMax accepts the bare
// shape, the tool is fine; if it 400s with "function name or parameters
// is empty", the router's `applyToolCompat` shim should inject a
// permissive `input_schema` on the entry.
const SERVER_TOOL_TYPES = [
  'web_fetch_20250924',
  'web_search_20250305',
  'code_execution_20250522',
  'bash_20250124',
  'text_editor_20250429',
  'text_editor_20250728',
  'memory_20250818',
];

function baseBody() {
  return {
    model: 'minimax',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'ping' }],
  };
}

function post(url, path, bodyObj) {
  const u = new URL(url);
  const body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 80,
        method: 'POST',
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function preview(s) {
  if (s.length <= BODY_PREVIEW_BYTES) return s;
  return s.slice(0, BODY_PREVIEW_BYTES) + `\n…[truncated ${s.length - BODY_PREVIEW_BYTES} more bytes]`;
}

const failures = [];

// Baseline: no tools, no betas. Must succeed or plumbing is broken.
{
  const label = 'baseline (no tools, no betas)';
  console.log(`\n→ sending ${label}`);
  let result;
  try {
    result = await post(ROUTER_URL, ROUTER_PATH, baseBody());
  } catch (err) {
    console.log(`  ✗ transport error: ${err.message}`);
    console.log(`  (is the router running? expected at ${ROUTER_URL})`);
    process.exit(1);
  }
  console.log(`  ← status=${result.status} body=${preview(result.body)}`);
  if (result.status !== 200) {
    failures.push(`baseline: expected 200, got ${result.status}`);
  }
}

// One variant per server-tool type.
for (const t of SERVER_TOOL_TYPES) {
  const name = t.replace(/_\d{8}$/, '');
  const label = `tools:[{type:"${t}",name:"${name}"}]`;
  console.log(`\n→ sending ${label}`);
  const body = { ...baseBody(), tools: [{ type: t, name }] };
  const result = await post(ROUTER_URL, ROUTER_PATH, body);
  const tag = result.status === 200 ? '✓' : '✗';
  console.log(`  ← ${tag} status=${result.status} body=${preview(result.body)}`);
}

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nDone. Any ✗ row above is a server-tool type the router\'s applyToolCompat shim didn\'t unblock.');
