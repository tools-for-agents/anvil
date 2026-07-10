// anvil run log — an opt-in, zero-dependency record of every sandbox run so a
// human (or agent) can review what was executed, its output and exit status.
// node:sqlite only. Enabled by setting ANVIL_DB (otherwise anvil stays stateless).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const DB_PATH = process.env.ANVIL_DB || './.anvil/runs.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
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
`);

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
  const rows = all(`SELECT id, ts, lang, image, cmd, network, ok, exit_code, timed_out, duration_ms,
                    substr(code,1,200) AS code_preview, substr(stdout,1,180) AS stdout_preview,
                    (length(COALESCE(stdout,''))+length(COALESCE(stderr,''))) AS out_bytes
                    FROM runs ORDER BY ts DESC LIMIT ?`, Math.min(limit, 500));
  return { count: rows.length, runs: rows.map(shape) };
}

export function getRun(id) { return shape(get(`SELECT * FROM runs WHERE id=?`, id)); }

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
