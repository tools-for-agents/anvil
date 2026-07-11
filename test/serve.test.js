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

const { logRun, stats, lineDiff, recentRuns, getRun } = await import('../src/log.js');
const { createAnvilServer } = await import('../src/server.js');

const okId = logRun({ opts: { lang: 'python', code: 'print(2**10)', network: 'none', mem: '512m', cpus: '1', timeout_ms: 30000 },
  result: { ok: true, exit_code: 0, timed_out: false, duration_ms: 120, image: 'python:3.12-alpine', stdout: '1024\n', stderr: '' } });
const failId = logRun({ opts: { lang: 'bash', code: 'exit 3' },
  result: { ok: false, exit_code: 3, timed_out: false, duration_ms: 60, image: 'alpine:3.20', stdout: '', stderr: 'boom\n' } });

test('log: stats aggregates ok / failed counts', () => {
  const s = stats();
  assert.equal(s.runs, 2);
  assert.equal(s.ok, 1);
  assert.equal(s.failed, 1);
  // by_lang drives the header language breakdown
  assert.ok(Array.isArray(s.by_lang), 'by_lang is an array');
  assert.equal(s.by_lang.reduce((a, e) => a + e.n, 0), s.runs, 'the per-language counts sum to the total');
  const langs = Object.fromEntries(s.by_lang.map((e) => [e.lang, e.n]));
  assert.equal(langs.python, 1);
  assert.equal(langs.bash, 1);
});

test('recentRuns coerces a bad limit instead of erroring / emptying the log', () => {
  const good = recentRuns();
  assert.equal(good.count, 2, 'baseline returns all runs');
  // ?limit=abc reaches recentRuns as NaN → Math.min(NaN,500) = NaN → LIMIT NaN
  // used to error; limit=0 → an empty log. All bad values fall back to the default.
  for (const bad of [NaN, 0, -5, 'abc', undefined]) {
    assert.equal(recentRuns({ limit: bad }).count, good.count, `limit=${String(bad)} recovers the default set`);
  }
  assert.equal(recentRuns({ limit: 1 }).count, 1, 'a valid small limit is still honoured');
});

test('search: run rows expose the fields the forge-log search box filters on', () => {
  const { runs } = recentRuns({ limit: 200 });
  // the client builds this haystack per row and substring-matches the query
  const hay = (r) => `${r.code_preview || ''} ${r.cmd || ''} ${r.lang || ''} ${r.image || ''} ${r.stdout_preview || ''}`.toLowerCase();
  const match = (q) => runs.filter((r) => hay(r).includes(q.toLowerCase()));
  assert.equal(match('print').length, 1, 'code text is searchable — "print" finds the python run');
  assert.equal(match('python').length, 1, 'language / image is searchable');
  assert.equal(match('1024').length, 1, 'stdout preview is searchable — "1024" finds the run that printed it');
  assert.equal(match('exit').length, 1, 'the bash "exit 3" run matches "exit"');
  assert.equal(match('zzzznope').length, 0, 'a non-match filters everything out');
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

    const diff = await fetch(`${base}/api/diff?a=${okId}&b=${failId}`).then((r) => r.json());
    assert.equal(diff.a.id, okId);
    assert.equal(diff.b.id, failId);
    assert.ok(diff.diff.code && diff.diff.stdout && diff.diff.stderr, 'diff has all three sections');
    assert.ok(diff.diff.code.changed > 0, 'the two runs have different code');

    const dmiss = await fetch(`${base}/api/diff?a=${okId}&b=run_nope`);
    assert.equal(dmiss.status, 404, 'diff with a missing run is 404');

    // rerun — Docker-free assertions (run() returns an error result without Docker,
    // and the endpoint still logs a new run and returns its id either way).
    const rrGet = await fetch(`${base}/api/rerun?id=${okId}`);
    assert.equal(rrGet.status, 405, 'rerun requires POST');
    const rrMiss = await fetch(`${base}/api/rerun?id=run_nope`, { method: 'POST' });
    assert.equal(rrMiss.status, 404, 'rerun with a missing run is 404');
    const before = (await fetch(`${base}/api/stats`).then((r) => r.json())).runs;
    const rr = await fetch(`${base}/api/rerun?id=${okId}`, { method: 'POST' }).then((r) => r.json());
    assert.ok(rr.run_id && rr.run_id !== okId, 'rerun logs a new run and returns its id');
    const after = (await fetch(`${base}/api/stats`).then((r) => r.json())).runs;
    assert.equal(after, before + 1, 'the rerun appears in the log');

    // exec — the dashboard "new run" form (Docker-free: run() returns an error result
    // without Docker, but the endpoint still logs a new run and returns its id).
    const exGet = await fetch(`${base}/api/exec`);
    assert.equal(exGet.status, 405, 'exec requires POST');
    const post = (body) => fetch(`${base}/api/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ lang: 'ruby', code: 'x' })).status, 400, 'unknown lang is 400');
    assert.equal((await post({ lang: 'python', code: '   ' })).status, 400, 'blank code is 400');
    const beforeEx = (await fetch(`${base}/api/stats`).then((r) => r.json())).runs;
    const ex = await post({ lang: 'python', code: 'print(1)' }).then((r) => r.json());
    assert.ok(ex.run_id, 'exec logs a new run and returns its id');
    const afterEx = (await fetch(`${base}/api/stats`).then((r) => r.json())).runs;
    assert.equal(afterEx, beforeEx + 1, 'the exec run appears in the log');

    // the resource-limit preset picker forwards mem/cpus/timeout to the logged run
    const strict = await post({ lang: 'python', code: 'print(1)', network: 'on', mem: '256m', cpus: '0.5', timeout_ms: 15000 }).then((r) => r.json());
    const rec = await fetch(`${base}/api/run?id=${strict.run_id}`).then((r) => r.json());
    assert.equal(rec.mem, '256m', 'the preset mem is recorded');
    assert.equal(rec.cpus, '0.5', 'the preset cpus is recorded');
    assert.equal(rec.timeout_ms, 15000, 'the preset timeout is recorded');
    assert.equal(rec.network, 'on', 'the networked profile is recorded');
    // a malformed limit is rejected — falls back to the run() default, not a bad docker flag
    const bad = await post({ lang: 'python', code: 'print(1)', mem: 'lots', cpus: 'abc' }).then((r) => r.json());
    const badRec = await fetch(`${base}/api/run?id=${bad.run_id}`).then((r) => r.json());
    assert.notEqual(badRec.mem, 'lots', 'a malformed mem is not forwarded to the container');
  } finally { server.close(); }
});

test('lineDiff aligns rows and marks adds/removes', () => {
  const d = lineDiff('a\nb\nc', 'a\nx\nc');
  assert.equal(d.identical, false);
  const del = d.rows.find((r) => r.lc === 'del');
  const add = d.rows.find((r) => r.rc === 'add');
  assert.equal(del.l, 'b');
  assert.equal(add.r, 'x');
  assert.ok(d.rows.some((r) => r.l === 'a' && r.r === 'a' && r.lc === 'same'), 'shared lines align as same');
  assert.equal(lineDiff('same\ntext', 'same\ntext').identical, true);
});

// Pruning lives at the END of this file on purpose: it empties the shared log,
// so anything asserting on the fixtures has to have run already.
test('serve: DELETE prunes the log — and a GET never can', async () => {
  const server = createAnvilServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const doomed = logRun({ opts: { lang: 'bash', code: 'echo doomed' },
      result: { ok: true, exit_code: 0, timed_out: false, duration_ms: 10, stdout: 'doomed\n', stderr: '' } });

    // reading is not deleting: GET hits the same path, twice, and the run survives
    assert.equal((await fetch(`${base}/api/run?id=${doomed}`).then((r) => r.json())).id, doomed);
    assert.ok((await fetch(`${base}/api/run?id=${doomed}`)).ok, 'a GET leaves the run in the log');

    // DELETE removes exactly that run, and nothing else
    const del = await fetch(`${base}/api/run?id=${doomed}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, doomed);
    assert.equal((await fetch(`${base}/api/run?id=${doomed}`)).status, 404, 'the deleted run is gone');
    assert.ok(getRun(okId), 'the other runs are untouched');

    // deleting an unknown run is a 404, not a silent success
    assert.equal((await fetch(`${base}/api/run?id=run_nope`, { method: 'DELETE' })).status, 404);

    // DELETE /api/runs clears the whole log and reports how many it dropped
    const before = (await fetch(`${base}/api/stats`).then((r) => r.json())).runs;
    assert.ok(before > 0, 'there are runs to clear');
    const cleared = await fetch(`${base}/api/runs`, { method: 'DELETE' }).then((r) => r.json());
    assert.equal(cleared.deleted, before, 'it reports the number of runs dropped');
    assert.equal((await fetch(`${base}/api/stats`).then((r) => r.json())).runs, 0, 'the log is empty');
  } finally { server.close(); }
});

test('serve: stats advertises where cortex lives, so a run can be kept in the brain', async () => {
  const server = createAnvilServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const s = await fetch(base + '/api/stats').then((r) => r.json());
    // anvil never writes to cortex — it only tells the page which brain to POST to
    assert.equal(s.cortex, 'http://localhost:7800', 'defaults to cortex serve');
    assert.ok('runs' in s, 'and still carries the log stats');
  } finally { server.close(); }
});

test('serve: /api/exec?stream=1 streams events and ends with the logged run', async () => {
  const server = createAnvilServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const res = await fetch(base + '/api/exec?stream=1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: 'bash', code: 'echo streamed' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    // read the whole stream and parse the events (works with or without Docker:
    // without it, run() reports the error and the run is still logged)
    const text = await res.text();
    const events = text.split('\n\n').filter(Boolean)
      .map((p) => { try { return JSON.parse(p.replace(/^data: /, '')); } catch { return null; } })
      .filter(Boolean);

    assert.equal(events[0].type, 'start', 'it opens with a start event');
    const done = events.at(-1);
    assert.equal(done.type, 'done', 'and closes with a done event');
    assert.ok(done.run_id, 'carrying the id of the run it logged');

    // the run really is in the log, so the stream and the record agree
    const rec = await fetch(`${base}/api/run?id=${done.run_id}`).then((r) => r.json());
    assert.equal(rec.id, done.run_id);
    assert.equal(rec.lang, 'bash');
  } finally { server.close(); }
});
