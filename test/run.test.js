// anvil tests — run with `node --test`. The preset/log/serve tests always run;
// the sandbox tests need a Docker that can actually *run a container* and skip
// cleanly otherwise. Note: some CI runners report a docker version but can't run
// containers (e.g. image-pull rate limits), so probing `docker version` is not
// enough — we run a throwaway container and only execute the exec tests if it works.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PRESETS, dockerAvailable, run } from '../src/run.js';

test('PRESETS map languages to images and commands', () => {
  assert.equal(PRESETS.python.image, 'python:3.12-alpine');
  assert.equal(PRESETS.node.cmd('main.js'), 'node main.js');
  assert.equal(PRESETS.bash.cmd('main.sh'), 'sh main.sh');
});

function canRunContainers() {
  if (!dockerAvailable()) return false;
  const r = spawnSync('docker', ['run', '--rm', 'alpine:3.20', 'echo', 'anvil-probe'],
    { encoding: 'utf8', timeout: 90_000 });
  return r.status === 0 && /anvil-probe/.test(r.stdout || '');
}
const noDocker = !canRunContainers() && 'docker cannot run containers in this environment';

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
