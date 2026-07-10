// anvil serve — a zero-dependency HTTP server for the run-history dashboard:
// what was executed in the sandbox, its output and exit status. Node's built-in
// http only. Read-only over the run log (src/log.js).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { recentRuns, getRun, diffRuns, logRun, stats } from './log.js';
import { run } from './run.js';

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
  '/api/diff': (q) => {
    const d = q.a && q.b && diffRuns(q.a, q.b);
    if (!d) throw new Error('run not found');
    return d;
  },
  // Re-execute a logged run (its exact code/command + limits) and log the result
  // as a new run. noLog so we log it ourselves and can return the new id.
  '/api/rerun': async (q) => {
    const src = q.id && getRun(q.id);
    if (!src) throw new Error('run not found');
    const base = { network: src.network || 'none', mem: src.mem || undefined,
      cpus: src.cpus || undefined, timeout_ms: src.timeout_ms || undefined, noLog: true };
    const opts = (src.lang && src.code != null)
      ? { lang: src.lang, code: src.code, ...base }
      : { image: src.image || 'alpine:3.20', cmd: src.cmd || '', ...base };
    const result = await run(opts);
    const run_id = logRun({ opts, result });
    return { run_id, ...result };
  },
  '/api/health': () => ({ ok: true, service: 'anvil', ts: new Date().toISOString() }),
};

const EXEC_LANGS = new Set(['bash', 'sh', 'node', 'javascript', 'python']);
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (c) => { size += c.length; if (size > 262144) { reject(new Error('body too large')); req.destroy(); } else data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}

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
    // /api/rerun executes code — require POST so a stray GET/prefetch can't trigger a run.
    if (url.pathname === '/api/rerun' && req.method !== 'POST') return json(res, 405, { error: 'use POST' });
    // /api/exec — run a fresh snippet from the dashboard's "new run" form (POST only; it executes code).
    if (url.pathname === '/api/exec') {
      if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
      try {
        const body = await readBody(req);
        const lang = String(body.lang || '').toLowerCase();
        if (!EXEC_LANGS.has(lang)) return json(res, 400, { error: 'lang must be one of: bash, node, python' });
        if (typeof body.code !== 'string' || !body.code.trim()) return json(res, 400, { error: 'code is required' });
        const opts = { lang, code: body.code, network: body.network === 'on' ? 'on' : 'none',
          timeout_ms: body.timeout_ms ? Math.min(+body.timeout_ms, 300000) : undefined, noLog: true };
        const result = await run(opts);
        const run_id = logRun({ opts, result });
        return json(res, 200, { run_id, ...result });
      } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
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
