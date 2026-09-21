// IS THE CANARY GATE STILL AIMED AT ANYTHING? — run with `node --test`.
//
// scripts/mutants.mjs is the gate that asks the question underneath every other gate: CAN THIS
// SUITE STILL FAIL. Each canary holds a LITERAL line of source, breaks it on purpose, and demands
// the suite go red. Literal is the whole point and it is also the whole fragility: edit that line —
// or merely quote it in the comment explaining why you didn't — and the canary matches 0× or 2×,
// mutants calls that a hard failure (`✗ ANCHOR DRIFTED`), and the job that proves the suite can
// still fail is itself red. Until someone re-points it, nothing is watching that property.
//
// Today that is a CI-only discovery, and an expensive one: the gate runs the whole suite nine times
// and EDITS YOUR SOURCE IN PLACE to do it, so nobody runs it before pushing. This file is the
// ten-millisecond half of the same question. It cannot tell you a canary still DIES — only that it
// is still aimed at exactly one line — and that is precisely the half that broke twice while fixing
// the CLI run log: first by chaining `.finally(…)` onto the anchored line (0 matches), then by
// pasting that same line verbatim into the comment warning against it (2 matches). Two opposite
// edits, one dead gate, a green `node --test` both times.
//
// 🔑 AND IT MUST NOT FIRE WHILE MUTANTS IS RUNNING. mutants plants a canary and then runs THIS
// SUITE, and it reads any red as "the canary died". A test that fails merely because a mutation is
// currently on disk would report every canary as killed — including canaries whose guarding test
// has stopped guarding anything. That is the same vacuous-gate bug one layer up, so the planted
// state is recognised and allowed: see EXEMPTION below.
//
// No skip here. scripts/ and test/ are both absent from package.json `files`, so this file only
// ever runs from a checkout — where the gate it guards is always present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gate = join(root, 'scripts', 'mutants.mjs');

// Read the CANARIES array out of the gate WITHOUT running it: importing mutants.mjs would take its
// lock, plant mutations in src/ and run the suite nine times. Slice the array literal and evaluate
// that alone — it is string and object literals, nothing that can act.
const canaries = await (async () => {
  assert.ok(existsSync(gate), 'scripts/mutants.mjs is missing — CI runs it as a required job (AGENTS.md)');
  const src = readFileSync(gate, 'utf8');
  const from = src.indexOf('const CANARIES = [');
  assert.notEqual(from, -1, 'scripts/mutants.mjs no longer declares `const CANARIES = [` — this test '
    + 'reads that array textually, and a rename would leave it checking nothing');
  const to = src.indexOf('\n];', from);
  assert.notEqual(to, -1, 'the CANARIES array is not closed by a line-leading `];` — cannot slice it');
  const block = src.slice(from, to + 3);
  const mod = await import('data:text/javascript,' + encodeURIComponent(`${block}\nexport default CANARIES;`));
  const list = mod.default;

  // Vacuity guards. Every assertion below is a loop over this array, so an empty or half-parsed
  // array would make the whole file pass by checking nothing — the exact shape of failure it exists
  // to catch. Count the `find:` keys in the file and demand the same number came back.
  assert.ok(Array.isArray(list) && list.length > 0, 'no canaries parsed out of scripts/mutants.mjs');
  const keys = (src.match(/^\s*find:/gm) || []).length;
  assert.equal(list.length, keys,
    `parsed ${list.length} canaries but scripts/mutants.mjs has ${keys} \`find:\` keys — the slice is `
    + 'missing some, so the anchors below are only partly checked');
  return list;
})();

// EXEMPTION: the anchor is gone AND this canary's sabotage is sitting in its place, exactly once.
// That is the state mutants itself creates, and only for the one canary it is testing right now
// (none of these `into` strings occur in the source at rest — checked, 0× each). In that state the
// anchor has not drifted, it is temporarily overwritten, and mutants' own ANCHOR DRIFTED check —
// which runs BEFORE it plants anything — is the authority. Anywhere else, a missing anchor is a
// dead canary and this goes red.
const state = canaries.map((c, i) => {
  const file = join(root, c.file);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
  return {
    n: i + 1,
    c,
    exists: text !== null,
    hits: text === null ? 0 : text.split(c.find).length - 1,
    mutated: text !== null && text.split(c.find).length - 1 === 0 && text.split(c.into).length - 1 === 1,
  };
});

// mutants restores each mutation before planting the next one — `planted` is a single slot. So one
// mid-mutation canary means the gate is mid-run; two means source that has rotted into the shape of
// its own sabotage, and the exemption above must not cover that.
test('at most ONE canary is mid-mutation — more than one is not a mutants run, it is rot', () => {
  const m = state.filter((s) => s.mutated);
  assert.ok(m.length <= 1,
    `${m.length} canaries (#${m.map((s) => s.n).join(', #')}) have their sabotage in place of their anchor. `
    + 'mutants plants one at a time, so this is not a gate in progress — the source itself now says what '
    + 'the canaries were written to catch.');
});

for (const s of state) {
  // The canary's own `why`, so a failure here names the PROPERTY that stopped being watched, not
  // just the string that stopped matching.
  test(`mutants canary #${s.n} still anchors, exactly once — ${s.c.why}`, () => {
    assert.ok(s.exists, `canary #${s.n} points at ${s.c.file}, which does not exist`);
    // A canary that plants the line it already found breaks nothing and can never be killed.
    assert.notEqual(s.c.into, s.c.find, `canary #${s.n} rewrites ${s.c.file} into what is already there`);
    if (s.mutated) return;                      // mutants is running; see EXEMPTION above
    assert.equal(s.hits, 1,
      `canary #${s.n} matches ${s.hits}× in ${s.c.file} (mutants needs exactly 1, and treats anything else `
      + `as a hard failure — the gate goes red and stops proving anything):\n    ${s.c.find}\n`
      + `  ${s.hits === 0
        ? 'The line moved or was edited. Re-point the canary in scripts/mutants.mjs, keeping what it was '
          + 'guarding — or restore the line.'
        : 'Something else in the file now says the same thing (a comment quoting it counts). Make the '
          + 'anchor unique again.'}`);
  });
}
