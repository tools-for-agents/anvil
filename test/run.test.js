// anvil tests — run with `node --test`. The preset tests always run; the
// sandbox tests need Docker and skip cleanly when it isn't available (CI runners
// have Docker, so they execute there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, dockerAvailable, run } from '../src/run.js';

test('PRESETS map languages to images and commands', () => {
  assert.equal(PRESETS.python.image, 'python:3.12-alpine');
  assert.equal(PRESETS.node.cmd('main.js'), 'node main.js');
  assert.equal(PRESETS.bash.cmd('main.sh'), 'sh main.sh');
});

const noDocker = !dockerAvailable() && 'docker not available';

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
