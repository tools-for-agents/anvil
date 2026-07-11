// anvil tests — run with `node --test`. The preset/log/serve tests always run;
// the sandbox tests need a Docker that can actually run anvil's containers and
// skip cleanly otherwise. Probing `docker version` (or a bare `docker run`) is
// not enough: some CI runners report a version and can run a plain container, yet
// reject the resource-limit flags anvil uses (--cpus / --memory-swap / --pids-limit
// / bind mount) under their constrained cgroups. So we probe with run() itself —
// the exact invocation the tests exercise — and skip if it can't produce output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, run } from '../src/run.js';

test('PRESETS map languages to images and commands', () => {
  assert.equal(PRESETS.python.image, 'python:3.12-alpine');
  assert.equal(PRESETS.node.cmd('main.js'), 'node main.js');
  assert.equal(PRESETS.bash.cmd('main.sh'), 'sh main.sh');
});

const probe = await run({ lang: 'bash', code: 'echo anvil-probe' }).catch(() => ({}));
const noDocker = !(probe.ok && /anvil-probe/.test(probe.stdout || '')) && 'docker cannot run anvil containers here';

test('run executes code and returns structured output', { skip: noDocker }, async () => {
  const r = await run({ lang: 'python', code: 'print(2**10)' });
  assert.equal(r.exit_code, 0);
  assert.match(r.stdout, /1024/);
  assert.equal(r.timed_out, false);
});

test('run surfaces a non-zero exit code and stderr', { skip: noDocker }, async () => {
  const r = await run({ lang: 'bash', code: 'echo oops 1>&2; exit 3' });
  assert.equal(r.exit_code, 3);
  assert.match(r.stderr, /oops/);
});

test('run is network-isolated by default', { skip: noDocker }, async () => {
  const r = await run({ lang: 'bash', code: 'wget -T 2 -q -O- http://example.com >/dev/null 2>&1 && echo ONLINE || echo OFFLINE' });
  assert.match(r.stdout, /OFFLINE/);
});

test('run enforces a hard timeout', { skip: noDocker }, async () => {
  const r = await run({ lang: 'bash', code: 'sleep 8', timeout_ms: 1500 });
  assert.equal(r.timed_out, true);
});

test('run streams output as the container writes it, not all at once at the end', { skip: noDocker }, async () => {
  const t0 = Date.now();
  const chunks = [];
  const r = await run({
    lang: 'bash',
    code: 'for i in 1 2 3; do echo tick $i; sleep 0.4; done; echo late >&2',
    onData: (stream, chunk) => chunks.push({ at: Date.now() - t0, stream, text: chunk }),
  });

  assert.equal(r.exit_code, 0);
  assert.ok(chunks.length >= 2, 'output arrived in pieces, not one lump');

  // the point of streaming: a chunk reached us well before the run finished
  const first = chunks[0];
  assert.ok(first.at < r.duration_ms - 200, `first chunk at ${first.at}ms, run took ${r.duration_ms}ms — it did not stream`);

  // both streams are distinguished
  assert.ok(chunks.some((c) => c.stream === 'stdout' && /tick 1/.test(c.text)));
  assert.ok(chunks.some((c) => c.stream === 'stderr' && /late/.test(c.text)));

  // and the buffered result is still whole — streaming must not eat the record
  assert.match(r.stdout, /tick 1\ntick 2\ntick 3/);
  assert.match(r.stderr, /late/);
});

test('a listener that throws cannot take the run down with it', { skip: noDocker }, async () => {
  const r = await run({ lang: 'bash', code: 'echo alive', onData: () => { throw new Error('bad listener'); } });
  assert.equal(r.ok, true, 'the run still completes');
  assert.match(r.stdout, /alive/);
});
