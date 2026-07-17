// anvil ordering test — the run log orders by `ts`, which is not unique: it is
// new Date().toISOString() at millisecond resolution, and anvil is written by three separate
// processes (CLI, MCP, web), so two runs finishing in the same tick tie. ORDER BY a tied column
// falls back to rowid, which is insertion order — undefined as a promise and disturbable by a
// deleteRun. The log now tie-breaks on id (the primary key: unique, so the order is fully
// determined). Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'anvil-order-'));
const dbPath = join(dir, 'runs.db');
process.env.ANVIL_DB = dbPath;
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const { logRun, recentRuns, deleteRun } = await import('../src/log.js');

// five runs; then force every ts to the same value — the tie a burst of concurrent runs produces
const ids = [];
for (let i = 0; i < 5; i++) ids.push(logRun({ opts: { lang: 'python', code: `print(${i})`, network: 'none' }, result: { ok: true, exit_code: 0 } }).id ?? null);
const TIED = '2026-07-10T12:00:00.000Z';
{
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE runs SET ts = ?').run(TIED);
  db.close();
}

const listedIds = () => recentRuns({ limit: 100 }).runs.map((r) => r.id);

test('the run log orders tied timestamps deterministically, by id', () => {
  const order = listedIds();
  const byIdDesc = [...order].sort().reverse();
  assert.deepEqual(order, byIdDesc,
    `tied runs must come back in a defined order (id DESC), not insertion order — got ${order}`);

  // and the order survives a delete: pull one out and the rest keep their relative positions.
  // (Only meaningful once the order is defined at all — an undefined order is not "stable".)
  const victim = order[Math.floor(order.length / 2)];
  deleteRun(victim);
  assert.deepEqual(listedIds(), order.filter((id) => id !== victim),
    'removing a run must leave every other run in the same relative order');
});
