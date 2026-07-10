// anvil serve + run-log tests — Docker-free (they exercise the log + HTTP layer,
// not the sandbox), so they always run in CI. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'anvil-serve-'));
process.env.ANVIL_DB = join(dir, 'runs.db');
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const { logRun, stats } = await import('../src/log.js');
const { createAnvilServer } = await import('../src/server.js');

const okId = logRun({ opts: { lang: 'python', code: 'print(2**10)', network: 'none', mem: '512m', cpus: '1', timeout_ms: 30000 },
  result: { ok: true, exit_code: 0, timed_out: false, duration_ms: 120, image: 'python:3.12-alpine', stdout: '1024\n', stderr: '' } });
logRun({ opts: { lang: 'bash', code: 'exit 3' },
  result: { ok: false, exit_code: 3, timed_out: false, duration_ms: 60, image: 'alpine:3.20', stdout: '', stderr: 'boom\n' } });

test('log: stats aggregates ok / failed counts', () => {
  const s = stats();
  assert.equal(s.runs, 2);
  assert.equal(s.ok, 1);
  assert.equal(s.failed, 1);
});

test('serve: runs list, run detail, stats and the not-found guard', async () => {
  const server = createAnvilServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const list = await fetch(base + '/api/runs').then((r) => r.json());
    assert.equal(list.count, 2, 'both runs are listed');
    assert.ok(list.runs[0].code_preview, 'list includes a code preview');

    const detail = await fetch(base + '/api/run?id=' + okId).then((r) => r.json());
    assert.equal(detail.exit_code, 0);
    assert.match(detail.stdout, /1024/, 'detail returns full stdout');
    assert.equal(detail.ok, true);

    const s = await fetch(base + '/api/stats').then((r) => r.json());
    assert.equal(s.runs, 2);

    const miss = await fetch(base + '/api/run?id=run_nope');
    assert.equal(miss.status, 404, 'unknown run id is 404');
  } finally { server.close(); }
});
