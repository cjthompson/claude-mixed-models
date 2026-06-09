import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  tokensByDay,
  requestsByHourOfDay,
  cacheHitRateByModel,
  topModels,
  topSessions,
  errorsByStatus,
  todaysTotals,
} from '../queries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH  = process.env.STATS_DB_PATH  ?? `${process.env.HOME}/.local/state/claude-mixed-models/router.stats.db`;
const DEFAULT_PORT     = Number(process.env.STATS_PORT ?? 8789);
const DEFAULT_PUBLIC_DIR = join(here, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// Open a fresh read-only connection per request. Cheap with `node:sqlite` (no connection
// pooling), and ensures the reader always sees the latest committed state under WAL.
function query(dbPath, range, fn) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return fn(db, range);
  } finally {
    db.close();
  }
}

function buildApiHandler(dbPath) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const range = url.searchParams.get('range') ?? '7d';
    if (!['24h', '7d', '30d', 'all'].includes(range)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown range: ${range}` }));
      return;
    }
    try {
      const payload = {
        range,
        tokensByDay:          query(dbPath, range, tokensByDay),
        requestsByHourOfDay:  query(dbPath, range, requestsByHourOfDay),
        cacheHitRateByModel:  query(dbPath, range, cacheHitRateByModel),
        topModels:            query(dbPath, range, topModels),
        topSessions:          query(dbPath, range, topSessions),
        errorsByStatus:       query(dbPath, range, errorsByStatus),
        // todaysTotals takes no range arg ("today" is always "today" in UTC).
        todaysTotals:         query(dbPath, 'all', todaysTotals),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      console.error('[stats-server] query error:', err.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  };
}

function buildStaticHandler(publicDir) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    // Prevent path traversal: reject `..` segments.
    if (path.includes('..')) {
      res.writeHead(400); res.end('bad path'); return;
    }
    const fullPath = join(publicDir, path);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) { res.writeHead(404); res.end('not found'); return; }
      const data = readFileSync(fullPath);
      const type = MIME[extname(fullPath)] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  };
}

// Exported for tests; the production bottom-of-module call starts the server.
export async function startServer({ dbPath = DEFAULT_DB_PATH, port = DEFAULT_PORT, publicDir = DEFAULT_PUBLIC_DIR, host = '127.0.0.1' } = {}) {
  const apiHandler    = buildApiHandler(dbPath);
  const staticHandler = buildStaticHandler(publicDir);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) apiHandler(req, res);
    else staticHandler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host}:${port}`;
  const close = () => new Promise((resolve) => server.close(() => resolve()));
  return { url, close, server };
}

// Install graceful shutdown when run as the main module.
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then(({ url }) => {
    console.log(`[stats-server] dashboard at ${url}`);
    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT',  () => process.exit(0));
  }).catch((err) => {
    console.error('[stats-server] fatal:', err);
    process.exit(1);
  });
}
