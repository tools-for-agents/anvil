// anvil line-diff tests — lineDiff builds an O(n×m) LCS matrix over the two outputs, and anvil
// diffs the output of UNTRUSTED code. Stored streams cap at 100K chars but nothing capped the
// LINE count, so 100K newlines twice made a 100K×100K matrix (~40 GB) and OOM-crashed the tool.
// lineDiff now caps the lines the matrix ever sees. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { lineDiff } = await import('../src/log.js');

test('a normal diff is exact and not flagged truncated', () => {
  const d = lineDiff('a\nb\nc', 'a\nX\nc');
  assert.equal(d.truncated, false);
  assert.equal(d.identical, false);
  assert.equal(d.changed, 2, 'one del + one add for the middle line');
  assert.deepEqual(d.rows.map((r) => r.lc), ['same', 'del', 'gap', 'same']);

  const same = lineDiff('x\ny', 'x\ny');
  assert.equal(same.identical, true);
  assert.equal(same.truncated, false);
});

test('a pathological output cannot allocate an unbounded matrix', () => {
  // 100K newlines each — the input that used to build a 40 GB matrix. It must return fast, with a
  // bounded number of rows, and say it was truncated.
  const a = '\n'.repeat(100_000), b = 'x\n'.repeat(100_000);
  const t = Date.now();
  const d = lineDiff(a, b);
  const ms = Date.now() - t;

  assert.equal(d.truncated, true, 'a diff over more than the line cap must report itself truncated');
  assert.ok(d.rows.length <= 8001, `rows must be bounded by ~2× the cap, got ${d.rows.length}`);
  assert.ok(ms < 2000, `a capped diff must finish quickly, took ${ms}ms`);
  // truncated → the tail was never compared, so it must never be called identical
  assert.equal(d.identical, false, 'a truncated diff cannot claim the two sides are identical');
});

test('the cap does not fire one line early — exactly at the boundary is not truncated', () => {
  // MAX_DIFF_LINES is 4000; 4000 lines (3999 newlines) must NOT truncate, so a real diff of a
  // large-but-reasonable output is still exact.
  const text = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
  const d = lineDiff(text, text);
  assert.equal(d.truncated, false, '4000 lines is at the cap, not over it');
  assert.equal(d.identical, true);
});
