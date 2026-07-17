// anvil concurrency test — anvil's run log is written by THREE separate processes: the CLI, the
// MCP server and the web view (its own db.js comment says so). WAL lets readers and ONE writer
// coexist and does nothing for two writers: without PRAGMA busy_timeout a second writer fails
// INSTANTLY with SQLITE_BUSY, and the comment records the measured cost on the same store shape —
// two concurrent writers lost 45 of 60 writes. busy_timeout is the fix, and until now nothing
// tested it: the run log could silently drop runs under contention and every logRun would look
// like it worked. This races real worker threads at a shared DB and asserts the invariant that
// must hold whatever the timing — every run lands, and nobody crashes on the lock. `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const work = mkdtempSync(join(tmpdir(), 'anvil-conc-'));
const dbPath = join(work, 'runs.db');
process.env.ANVIL_DB = dbPath;
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const { recentRuns } = await import('../src/log.js');

const WORKERS = 8;
const PER_WORKER = 4;   // 32 runs total, logged in overlapping bursts

// Each worker: point at the shared DB, import log.js fresh, wait on the barrier, then log a burst.
const WORKER = `
  const { workerData, parentPort } = require('node:worker_threads');
  process.env.ANVIL_DB = workerData.dbPath;
  (async () => {
    const { logRun } = await import(${JSON.stringify(new URL('../src/log.js', import.meta.url).href)});
    parentPort.postMessage({ ready: true });
    await new Promise((r) => parentPort.once('message', r));   // barrier: all workers write together
    const errors = [];
    for (let i = 0; i < workerData.perWorker; i++) {
      try { logRun({ opts: { lang: 'python', code: 'print(' + i + ')', network: 'none' }, result: { ok: true, exit_code: 0 } }); }
      catch (e) { errors.push(String(e && e.message || e)); }
    }
    parentPort.postMessage({ errors });
  })();
`;

test('every run lands under real write contention, and nobody crashes on the lock', async () => {
  const ws = Array.from({ length: WORKERS }, () =>
    new Worker(WORKER, { eval: true, workerData: { dbPath, perWorker: PER_WORKER } }));
  await Promise.all(ws.map((w) => new Promise((r) => w.once('message', r))));   // all ready
  const done = ws.map((w) => new Promise((r) => w.once('message', r)));
  ws.forEach((w) => w.postMessage('go'));                                        // release together
  const results = await Promise.all(done);
  await Promise.all(ws.map((w) => w.terminate()));

  const crashed = results.flatMap((r) => r.errors);
  assert.deepEqual(crashed, [], `no writer may crash on the lock — busy_timeout is what prevents it: ${JSON.stringify(crashed)}`);

  // and every INSERT is present: WORKERS × PER_WORKER rows, none dropped
  const n = recentRuns({ limit: 1000 }).runs.length;
  assert.equal(n, WORKERS * PER_WORKER, `all ${WORKERS * PER_WORKER} runs must be logged, found ${n}`);
});
