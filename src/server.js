// anvil serve — a zero-dependency HTTP server for the run-history dashboard:
// what was executed in the sandbox, its output and exit status. Node's built-in
// http only. Read-only over the run log (src/log.js).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { recentRuns, getRun, stats } from './log.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

const api = {
  '/api/stats': () => stats(),
  '/api/runs': (q) => recentRuns({ limit: q.limit ? +q.limit : 100 }),
  '/api/run': (q) => {
    const r = q.id && getRun(q.id);
    if (!r) throw new Error('run not found');
    return r;
  },
  '/api/health': () => ({ ok: true, service: 'anvil', ts: new Date().toISOString() }),
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  }
}

export function createAnvilServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' });
      return res.end();
    }
    const handler = api[url.pathname];
    if (handler) {
      const q = Object.fromEntries(url.searchParams.entries());
      try { return json(res, 200, await handler(q)); }
      catch (e) { return json(res, e.message === 'run not found' ? 404 : 400, { error: String(e.message || e) }); }
    }
    return serveStatic(res, url.pathname);
  });
}

export function serve({ port = process.env.ANVIL_PORT || 7930 } = {}) {
  const server = createAnvilServer();
  server.listen(port, () => {
    const s = stats();
    console.log(`\n  ⚒ anvil forge log → http://localhost:${port}`);
    console.log(`    ${s.runs} runs logged (${s.ok} ok · ${s.failed} failed) → ${s.db}\n`);
  });
  return server;
}
