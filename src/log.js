// anvil run log — an opt-in, zero-dependency record of every sandbox run so a
// human (or agent) can review what was executed, its output and exit status.
// node:sqlite only. Enabled by setting ANVIL_DB (otherwise anvil stays stateless).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const DB_PATH = process.env.ANVIL_DB || './.anvil/runs.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

// Block this thread for `ms`. Opening the database is synchronous, so a retry has to be too.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  lang        TEXT,
  image       TEXT,
  cmd         TEXT,
  code        TEXT,
  network     TEXT,
  mem         TEXT,
  cpus        TEXT,
  timeout_ms  INTEGER,
  ok          INTEGER,
  exit_code   INTEGER,
  timed_out   INTEGER,
  duration_ms INTEGER,
  stdout      TEXT,
  stderr      TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs(ts DESC);
`;

// 🔑 WAL LETS READERS AND A WRITER COEXIST. IT DOES NOTHING FOR TWO WRITERS. Without busy_timeout the
// second writer does not WAIT for the lock — it fails INSTANTLY with SQLITE_BUSY. anvil's log is
// written by the CLI, the MCP server and the web view, which are three separate processes; measured
// on cortex (same store shape), two concurrent writers lost 45 of 60 writes. And busy_timeout does
// not save the OPEN itself — `PRAGMA journal_mode = WAL` takes a brief exclusive lock and SQLite
// answers SQLITE_BUSY for it immediately — so the open retries, and the schema goes up atomically.
function openDb() {
  for (let attempt = 0; ; attempt++) {
    let d;
    try {
      d = new DatabaseSync(DB_PATH);
      d.exec('PRAGMA busy_timeout = 5000;');
      d.exec('PRAGMA journal_mode = WAL;');
      d.exec('BEGIN IMMEDIATE;');
      d.exec(SCHEMA);
      d.exec('COMMIT;');
      return d;
    } catch (e) {
      try { d?.close(); } catch { /* already gone */ }
      // Only a lock is worth retrying — a loop that hides a real fault is worse than the fault.
      if (attempt >= 40 || !/lock|busy/i.test(e.message)) throw e;
      sleepSync(25);
    }
  }
}

export const db = openDb();


const get = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const runq = (sql, ...a) => db.prepare(sql).run(...a);
const CAP = 100_000;
const clip = (s) => (s == null ? null : String(s).slice(0, CAP));

// Persist one run. Accepts anvil run opts + the structured result; tolerant of
// partial data. Returns the new row id.
export function logRun({ opts = {}, result = {} } = {}) {
  const id = 'run_' + randomUUID().slice(0, 12);
  runq(`INSERT INTO runs (id,ts,lang,image,cmd,code,network,mem,cpus,timeout_ms,ok,exit_code,timed_out,duration_ms,stdout,stderr,error)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, new Date().toISOString(),
    opts.lang || null, result.image || opts.image || null, opts.cmd || null, clip(opts.code),
    opts.network || 'none', opts.mem || null, opts.cpus != null ? String(opts.cpus) : null,
    opts.timeout_ms != null ? opts.timeout_ms : null,
    result.ok ? 1 : 0, result.exit_code != null ? result.exit_code : null,
    result.timed_out ? 1 : 0, result.duration_ms != null ? result.duration_ms : null,
    clip(result.stdout), clip(result.stderr), result.error || null);
  return id;
}

const shape = (r) => r && { ...r, ok: !!r.ok, timed_out: !!r.timed_out };

export function recentRuns({ limit = 100 } = {}) {
  // Harden the limit: a non-numeric query param arrives as NaN (server parses
  // ?limit=abc with +q.limit), and `Math.min(NaN, 500)` is NaN → `LIMIT NaN`
  // errors the query; limit=0 → an empty log. Fall back to the default.
  limit = Number.isFinite(+limit) && +limit > 0 ? Math.min(Math.floor(+limit), 500) : 100;
  const rows = all(`SELECT id, ts, lang, image, cmd, network, ok, exit_code, timed_out, duration_ms,
                    substr(code,1,200) AS code_preview, substr(stdout,1,180) AS stdout_preview,
                    (length(COALESCE(stdout,''))+length(COALESCE(stderr,''))) AS out_bytes
                    FROM runs ORDER BY ts DESC LIMIT ?`, limit);
  return { count: rows.length, runs: rows.map(shape) };
}

export function getRun(id) { return shape(get(`SELECT * FROM runs WHERE id=?`, id)); }

// Prune the log. It grows with every run — and every re-run — so a sandbox that
// has been hammered needs a way to drop a noisy run, or start clean.
export function deleteRun(id) { return runq(`DELETE FROM runs WHERE id=?`, id).changes > 0; }
export function clearRuns() { return runq(`DELETE FROM runs`).changes; }

// LCS line diff → aligned rows [{ l, r, lc, rc }] where l/r are the left/right
// line (or null for a gap) and lc/rc are 'same' | 'del' | 'add' | 'gap'.
export function lineDiff(aText, bText) {
  const a = String(aText || '').split('\n'), b = String(bText || '').split('\n');
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0, j = 0, changed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ l: a[i], r: b[j], lc: 'same', rc: 'same' }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ l: a[i], r: null, lc: 'del', rc: 'gap' }); i++; changed++; }
    else { rows.push({ l: null, r: b[j], lc: 'gap', rc: 'add' }); j++; changed++; }
  }
  while (i < n) { rows.push({ l: a[i], r: null, lc: 'del', rc: 'gap' }); i++; changed++; }
  while (j < m) { rows.push({ l: null, r: b[j], lc: 'gap', rc: 'add' }); j++; changed++; }
  return { rows, changed, identical: changed === 0 };
}

// Compare two logged runs: both records + line diffs of code / stdout / stderr.
export function diffRuns(idA, idB) {
  const a = getRun(idA), b = getRun(idB);
  if (!a || !b) return null;
  return {
    a, b,
    diff: {
      code: lineDiff(a.code, b.code),
      stdout: lineDiff(a.stdout, b.stdout),
      stderr: lineDiff(a.stderr, b.stderr),
    },
  };
}

export function stats() {
  const s = get(`SELECT COUNT(*) n,
                   SUM(CASE WHEN ok=1 THEN 1 ELSE 0 END) ok,
                   SUM(CASE WHEN timed_out=1 THEN 1 ELSE 0 END) timed_out,
                   COALESCE(SUM(duration_ms),0) total_ms,
                   COALESCE(AVG(duration_ms),0) avg_ms
                 FROM runs`);
  return {
    db: DB_PATH,
    runs: s.n, ok: s.ok || 0, failed: (s.n || 0) - (s.ok || 0), timed_out: s.timed_out || 0,
    total_ms: s.total_ms, avg_ms: Math.round(s.avg_ms || 0),
    by_lang: all(`SELECT COALESCE(lang, image, 'sh') AS lang, COUNT(*) n FROM runs GROUP BY lang ORDER BY n DESC`),
  };
}

export { DB_PATH };
