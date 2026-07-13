// anvil serve — a zero-dependency HTTP server for the run-history dashboard:
// what was executed in the sandbox, its output and exit status. Node's built-in
// http only. Read-only over the run log (src/log.js).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, isAbsolute, sep } from 'node:path';
import { recentRuns, getRun, diffRuns, logRun, deleteRun, clearRuns, stats } from './log.js';
import { run, dockerStatus } from './run.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

// Where cortex's web view lives, so a run can be kept in the brain.
// anvil never writes to it — the browser POSTs to cortex's own /api/capture.
const CORTEX_URL = (process.env.ANVIL_CORTEX_URL || 'http://localhost:7800').replace(/\/$/, '');

const api = {
  // THE PAGE MUST SAY WHEN THE TOOL CANNOT WORK AT ALL.
  //
  // With Docker dead, the forge log showed "The forge is cold — no runs yet" and a
  // cheerful "+ new run" button that could not possibly work. The forge is not cold.
  // THERE IS NO FORGE. An empty state that implies readiness, on a tool that cannot run
  // anything, is the same lie as an empty store answering a query.
  '/api/stats': () => ({ ...stats(), docker: dockerStatus(), cortex: CORTEX_URL }),
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
const MAX_BODY = 512 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0, over = false;
    // Drain rather than destroy: killing the socket gives the caller an ECONNRESET
    // instead of a reason. Stop accumulating, then reject at the end so the handler
    // can answer with something a human can read.
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { over = true; return; } data += c; });
    req.on('end', () => {
      if (over) return reject(new Error('body too large'));
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC, rel));
  // startsWith(PUBLIC) alone lets a SIBLING directory through: if PUBLIC is /app/public, then
  // /app/public-secrets/keys.txt also startsWith('/app/public'). A request path of
  // `/../public-secrets/keys.txt` resolves to exactly that and sailed past the guard. Require the
  // path separator, so "inside PUBLIC" means inside it and not merely next to something spelled
  // like it. (iris had the same bug one file over; this is the same fix, kit-wide.)
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + sep)) { res.writeHead(403); return res.end('forbidden'); }
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
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' });
      return res.end();
    }
    // /api/rerun executes code — require POST so a stray GET/prefetch can't trigger a run.
    if (url.pathname === '/api/rerun' && req.method !== 'POST') return json(res, 405, { error: 'use POST' });
    // Pruning is destructive, so it lives behind DELETE on the same paths that GET
    // reads: a stray GET or a link prefetch must never be able to wipe the log.
    if (url.pathname === '/api/run' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id || !deleteRun(id)) return json(res, 404, { error: 'run not found' });
      return json(res, 200, { ok: true, deleted: id });
    }
    if (url.pathname === '/api/runs' && req.method === 'DELETE') {
      return json(res, 200, { ok: true, deleted: clearRuns() });
    }
    // /api/exec — run a fresh snippet from the dashboard's "new run" form (POST only; it executes code).
    if (url.pathname === '/api/exec') {
      if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
      try {
        const body = await readBody(req);
        const stream = url.searchParams.get('stream') === '1';
        const opts = { network: body.network === 'on' ? 'on' : 'none', noLog: true };

        // Two ways to run: a snippet in a language preset, or a command in an image.
        // The command form is what makes anvil's headline trick possible from here —
        // run a real repo's test suite without copying the repo anywhere.
        if (body.mode === 'command') {
          const image = String(body.image || '').trim();
          if (!/^[a-z0-9][a-z0-9._\/-]{0,120}(:[a-zA-Z0-9._-]{1,60})?$/.test(image)) {
            return json(res, 400, { error: 'image must be a docker image name, e.g. node:22-alpine' });
          }
          if (typeof body.cmd !== 'string' || !body.cmd.trim()) return json(res, 400, { error: 'cmd is required' });
          opts.image = image; opts.cmd = body.cmd;
        } else {
          const lang = String(body.lang || '').toLowerCase();
          if (!EXEC_LANGS.has(lang)) return json(res, 400, { error: 'lang must be one of: bash, node, python' });
          if (typeof body.code !== 'string' || !body.code.trim()) return json(res, 400, { error: 'code is required' });
          opts.lang = lang; opts.code = body.code;
        }

        // A host directory, mounted READ-ONLY at /repo. It has to exist and be a
        // directory, or docker would fail with something unhelpful — say so here.
        if (body.mount) {
          const mount = String(body.mount).trim();
          if (!isAbsolute(mount)) return json(res, 400, { error: 'mount must be an absolute path' });
          let st; try { st = statSync(mount); } catch { return json(res, 400, { error: `no such directory: ${mount}` }); }
          if (!st.isDirectory()) return json(res, 400, { error: `not a directory: ${mount}` });
          opts.mount = mount;
        }
        if (body.secure === true) opts.secure = true;   // read-only rootfs + tmpfs /tmp

        // Fixture files, written into /work beside the snippet before it runs — so
        // you can test code against data, or a module against its test. run() already
        // refuses traversal (safeJoin); refuse it here too, with a readable reason,
        // and cap the payload so the form can't hand the sandbox a filesystem.
        if (body.files && typeof body.files === 'object') {
          const files = {};
          let total = 0;
          for (const [rel, content] of Object.entries(body.files)) {
            const name = String(rel).trim();
            if (!name) continue;
            if (isAbsolute(name) || name.split('/').includes('..')) {
              return json(res, 400, { error: `file path must stay inside the sandbox: ${name}` });
            }
            const text = String(content ?? '');
            total += name.length + text.length;
            files[name] = text;
          }
          if (Object.keys(files).length > 12) return json(res, 400, { error: 'at most 12 files' });
          if (total > 128 * 1024) return json(res, 400, { error: 'files are too large (128KB max)' });
          if (Object.keys(files).length) opts.files = files;
        }
        if (typeof body.stdin === 'string' && body.stdin.length) opts.stdin = body.stdin;
        // resource profile from the new-run form's preset picker — validated so a
        // malformed value can't reach the docker flags (falls back to run() defaults)
        if (typeof body.mem === 'string' && /^\d{1,5}m$/.test(body.mem)) opts.mem = body.mem;
        if (body.cpus != null && Number.isFinite(+body.cpus) && +body.cpus > 0) opts.cpus = String(+body.cpus);
        if (body.timeout_ms != null && Number.isFinite(+body.timeout_ms) && +body.timeout_ms > 0) opts.timeout_ms = Math.min(Math.floor(+body.timeout_ms), 300000);
        // Streaming: the sandbox writes as it goes, so say so as it goes. SSE over the
        // POST response (EventSource can't POST, and the code belongs in a body, not a
        // URL) — the client reads it with fetch + a stream reader.
        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
            Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
          });
          const send = (o) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch {} };
          let closed = false;
          req.on('close', () => { closed = true; });
          opts.onData = (kind, chunk) => { if (!closed) send({ type: kind, chunk }); };
          send({ type: 'start', lang: opts.lang || opts.image, mount: opts.mount || null, ts: new Date().toISOString() });
          const result = await run(opts);
          const run_id = logRun({ opts, result });
          send({ type: 'done', run_id, ...result });
          return res.end();
        }
        const result = await run(opts);
        const run_id = logRun({ opts, result });
        return json(res, 200, { run_id, ...result });
      } catch (e) {
        // If the stream is already open, the headers are long gone — say it down the
        // stream and close, rather than trying (and failing) to send a JSON error.
        if (res.headersSent) {
          try { res.write(`data: ${JSON.stringify({ type: 'done', error: String(e.message || e) })}\n\n`); } catch {}
          return res.end();
        }
        return json(res, 400, { error: String(e.message || e) });
      }
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
