// anvil tests — run with `node --test`.
//
// ⚠ NEVER GATE A TEST ON THE THING IT IS TESTING.
//
// This guard used to probe by calling run() — "the exact invocation the tests exercise".
// The reasoning was sound (some runners report a docker version and run a plain container
// yet reject anvil's --cpus / --memory-swap / --pids-limit flags), and the consequence was
// catastrophic: when anvil itself broke, the probe broke with it, the guard concluded
// "no Docker here", and every sandbox test SKIPPED.
//
// On Linux, anvil could not read the file it had just written (--cap-drop ALL removes
// CAP_DAC_OVERRIDE, so container-root cannot read a 0700 host dir). The suite went GREEN
// on every Linux CI run for the entire life of the project:
//
//     ℹ tests 20   ℹ pass 11   ℹ fail 0   ℹ skipped 9
//
// Nine skipped. Nobody looks at "skipped". The tool did not work at all on the only
// platform it ships to, and its own test suite reported success.
//
// So the probe now asks the ENVIRONMENT a question about ITSELF — can this docker run a
// container with anvil's resource flags? — using docker directly, with no bind mount and
// no file anvil wrote. A bug in anvil can no longer switch off the tests that would catch
// it. A skip must mean "this machine cannot run the test", never "the code is broken".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PRESETS, run, safeJoin } from '../src/run.js';

test('PRESETS map languages to images and commands', () => {
  assert.equal(PRESETS.python.image, 'python:3.12-alpine');
  assert.equal(PRESETS.node.cmd('main.js'), 'node main.js');
  assert.equal(PRESETS.bash.cmd('main.sh'), 'sh main.sh');
});

const probe = spawnSync('docker', [
  'run', '--rm', '--network', 'none',
  '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
  '--pids-limit', '512', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
  'alpine:3.20', '/bin/sh', '-c', 'echo anvil-probe',
], { encoding: 'utf8', timeout: 300_000 });
const noDocker = probe.status === 0 && /anvil-probe/.test(probe.stdout || '')
  ? false
  : 'this docker cannot run anvil-style containers (no daemon, or the resource flags are rejected)';

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

test('a mounted repo is visible at /repo — and read-only', { skip: noDocker }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'anvil-repo-'));
  writeFileSync(join(repo, 'package.json'), '{"name":"the-repo"}\n');

  // this is anvil's headline trick: verify a real repo without copying it anywhere
  const seen = await run({ lang: 'bash', code: 'cat /repo/package.json', mount: repo });
  assert.equal(seen.exit_code, 0);
  assert.match(seen.stdout, /the-repo/, 'the sandbox can read the mounted repo');

  // …and cannot touch it. A sandbox that can write to your repo is not a sandbox.
  const wrote = await run({ lang: 'bash', code: 'echo pwned > /repo/package.json; echo done', mount: repo });
  assert.match(wrote.stderr + wrote.stdout, /Read-only|Permission denied|cannot create/i,
    'writing to the mount is refused');
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(join(repo, 'package.json'), 'utf8'), /the-repo/, 'the host file is untouched');
});

test('a command runs in any image, not just the language presets', { skip: noDocker }, async () => {
  const r = await run({ image: 'alpine:3.20', cmd: 'echo from-a-command && uname -s' });
  assert.equal(r.exit_code, 0);
  assert.match(r.stdout, /from-a-command/);
  assert.match(r.stdout, /Linux/);
});

test('a snippet can be run against fixture files, and stdin', { skip: noDocker }, async () => {
  // the point of files: run code AGAINST something, not just on its own
  const r = await run({
    lang: 'python',
    code: 'import json\nd = json.load(open("data.json"))\nprint(d["kind"], len(d["items"]))',
    files: { 'data.json': JSON.stringify({ kind: 'fixture', items: [1, 2, 3] }) },
  });
  assert.equal(r.exit_code, 0, r.stderr);
  assert.match(r.stdout, /fixture 3/, 'the code read the file that was written beside it');

  // a module against its test — the case that makes this worth having
  const t = await run({
    lang: 'bash',
    code: 'node -e "const {add}=require(\'./m.js\'); if(add(2,3)!==5) { console.error(\'FAIL\'); process.exit(1) } console.log(\'PASS\')"',
    image: 'node:22-alpine',
    files: { 'm.js': 'module.exports.add = (a, b) => a + b;\n' },
  });
  assert.equal(t.exit_code, 0, t.stderr);
  assert.match(t.stdout, /PASS/);

  // stdin is piped to the process
  const s = await run({ lang: 'bash', code: 'cat | tr a-z A-Z', stdin: 'shout this' });
  assert.match(s.stdout, /SHOUT THIS/);
});

// ── stdout IS the protocol ──────────────────────────────────────────────────────
// An MCP server speaks newline-delimited JSON-RPC on stdout and NOTHING else.
//
// One console.log anywhere in a code path a tool can reach — a leftover debug line, a
// helpful progress message — puts a line on that stream which is not a message. The
// client desyncs. It does not fail loudly: the call simply never comes back, or comes
// back as the wrong reply to the wrong request, and the agent is left holding a session
// that has quietly stopped working. It is the single easiest way to break an MCP server,
// and the hardest to notice, because everything still LOOKS fine.
//
// A dynamic check cannot cover this: it only sees the code paths it happens to exercise,
// and a debug line inside `search()` is invisible until someone searches. So walk the
// import graph from the server itself and refuse the whole class.
//
// `cli.js` and `server.js` are the CLI and the `serve` command — they are meant to print,
// and the MCP server never imports them. If that ever changes, this test is what tells you.
test('nothing the MCP server can reach is allowed to print to stdout', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, resolve, relative } = await import('node:path');

  const entry = resolve(import.meta.dirname, '..', 'mcp', 'mcp-server.js');
  const seen = new Set();
  const offenders = [];

  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');

    // The server itself writes the protocol — that is its job. Everything it pulls in must not.
    if (file !== entry) {
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                       // a comment about it is fine
        if (/console\.(log|info|debug|dir|table)\s*\(|process\.stdout\.write\s*\(/.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      walk(resolve(dirname(file), m[1]));
    }
  };
  walk(entry);

  // agent-hq's MCP server imports nothing local — it is a thin HTTP client over the
  // platform's API — so for it this walk finds only the entry file, and there is genuinely
  // nothing to check. That is not a vacuous pass: it is the guard that fires the day
  // somebody wires the server straight into services.js, which does print.
  assert.ok(seen.size >= 1, 'the entry point was found');
  assert.deepEqual(offenders, [],
    'stdout is the protocol — one stray print desyncs every agent session:\n  ' + offenders.join('\n  '));
});

// ── "docker is not available" is two different problems ─────────────────────────
test('a missing Docker and a sleeping Docker are not the same sentence', async (t) => {
  const { mkdtempSync, rmSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { spawnSync, execSync } = await import('node:child_process');

  // The whole message used to be: `docker is not available`. It names no cause, suggests
  // no action, and CONFLATES TWO SITUATIONS WITH DIFFERENT FIXES — one you solve by
  // installing Docker, the other by starting it. I hit the second myself, twice in a day:
  // Docker Desktop had quit, and anvil said the same six words it says to someone who has
  // never installed it.
  const node = execSync('which node', { encoding: 'utf8' }).trim();
  const ask = (path) => {
    const r = spawnSync(node, ['--input-type=module', '-e',
      "import { dockerStatus } from './src/run.js'; console.log(JSON.stringify(dockerStatus()));"],
      { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, PATH: path } });
    return JSON.parse(r.stdout.trim());
  };

  // 1. No docker binary at all.
  const empty = mkdtempSync(join(tmpdir(), 'anvil-nodocker-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const gone = ask(empty);
  assert.equal(gone.reason, 'not-installed');
  assert.match(gone.error, /not installed/i);
  assert.match(gone.error, /docs\.docker\.com/, 'and says where to get it');

  // 2. A docker that exists and cannot reach its daemon — a completely different fix.
  const fake = mkdtempSync(join(tmpdir(), 'anvil-deaddaemon-'));
  t.after(() => rmSync(fake, { recursive: true, force: true }));
  const bin = join(fake, 'docker');
  writeFileSync(bin, '#!/bin/sh\necho "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" 1>&2\nexit 1\n');
  chmodSync(bin, 0o755);
  const asleep = ask(`${fake}:${dirname(node)}`);
  assert.equal(asleep.reason, 'daemon-down');
  assert.match(asleep.error, /daemon is not running/i, 'it says the daemon, not the install');
  assert.match(asleep.error, /Docker Desktop|systemctl start docker/, 'and says how to start it');
  assert.doesNotMatch(asleep.error, /not installed/i, 'and does NOT send you looking for the wrong problem');
});

// ANVIL COULD NOT RUN CODE FROM A FILE ON LINUX. AT ALL. EVER.
//
//   python: can't open file '/work/main.py': [Errno 13] Permission denied
//
// `--cap-drop ALL` removes CAP_DAC_OVERRIDE — the capability that lets root ignore file
// permissions — and the work dir is mkdtemp's 0700, owned by the host user. So root in the
// container could not read the file the host had just written. On Linux — every CI runner,
// every server — the sandbox tool did not work.
//
// macOS HID IT: Docker Desktop launders ownership through its VM. The fix was not to loosen
// permissions but to STOP BEING ROOT: match the container uid to the host uid.
//
// And nothing was guarding it. A canary deleted the --user flag outright and this suite
// stayed green — on macOS it passes either way, which is the very reason the bug survived
// for anvil's entire life. So assert the thing itself: we are not root.
test('the sandbox does not run as root', { skip: noDocker }, async () => {
  const r = await run({ lang: 'bash', code: 'id -u' });
  assert.equal(r.exit_code, 0);
  assert.notEqual(r.stdout.trim(), '0',
    'the container is running as ROOT — without --user, anvil cannot read its own work dir on Linux');
});

// `--cap-drop ALL` is the difference between "code you did not write, in a box" and "code you
// did not write, holding capabilities". Nothing was guarding that either: the flag could be
// swapped for a no-op label and the suite went green.
//
// The kernel will tell you plainly — but you have to ask it the RIGHT question.
//
// My first attempt asserted CapEff (the EFFECTIVE set) and it could not fail: a non-root
// process has an empty effective set whether or not you drop capabilities, so the assertion
// was true in both worlds and killed nothing. A test that cannot tell the two apart is not
// a test, it is a decoration — and the canary said so.
//
// CapBnd is the BOUNDING set: the ceiling on what this process could EVER acquire, including
// through a setuid binary. That ceiling is the actual sandbox guarantee, and it is zero only
// because --cap-drop ALL made it zero.
test('the sandbox holds no capabilities, and can never acquire any', { skip: noDocker }, async () => {
  const r = await run({ lang: 'bash', code: 'grep -E "^Cap(Eff|Bnd)" /proc/self/status' });
  assert.equal(r.exit_code, 0);
  const eff = (r.stdout.match(/CapEff:\s*([0-9a-f]+)/) || [])[1];
  const bnd = (r.stdout.match(/CapBnd:\s*([0-9a-f]+)/) || [])[1];
  assert.ok(eff && bnd, `could not read the capability sets, got: ${JSON.stringify(r.stdout)}`);
  assert.match(eff, /^0+$/, `the sandbox holds capabilities (CapEff=${eff})`);
  assert.match(bnd, /^0+$/,
    `the sandbox could still ACQUIRE capabilities (CapBnd=${bnd}) — --cap-drop ALL is not doing its job`);
});

// THE FILE MAP IS WRITTEN TO THE HOST BEFORE THE CONTAINER STARTS — so its guard is host-side.
//
// An agent hands anvil a `files` map to materialize into the sandbox work dir. The KEYS are the
// caller's, and safeJoin() decides where each one lands ON THE HOST, before Docker is ever invoked.
// A key like `../../etc/cron.d/evil` is an attempt to write attacker-chosen bytes outside the work
// dir; if it slips past, Docker never sees it because the damage is already done on the host.
//
// This needs NO Docker — it is a pure path check — so it does not carry the docker skip. A security
// test gated on the very dependency the guard runs BEFORE would never run on a box without it.
test('safeJoin refuses to write outside the work directory, however the path is spelled', () => {
  const base = '/tmp/anvil-work-abc123';

  // the safe case still works
  assert.equal(safeJoin(base, 'main.py'), `${base}/main.py`, 'an ordinary filename lands inside');
  assert.equal(safeJoin(base, 'sub/dir/f.txt'), `${base}/sub/dir/f.txt`, 'and so does a nested one');

  for (const rel of [
    '../escape.txt',                 // one level up
    '../../../../etc/cron.d/evil',   // straight out to a host dir
    '/etc/passwd',                   // absolute path
    'a/../../escape',                // sneaks up after descending
    '../anvil-work-abc123-evil/f',   // the SIBLING-PREFIX hole: starts with base, is not inside it
  ]) {
    assert.throws(() => safeJoin(base, rel), /unsafe file path/,
      `must refuse to write outside the work dir: ${JSON.stringify(rel)}`);
  }
});
