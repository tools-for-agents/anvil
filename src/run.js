// anvil core — run code/commands in a throwaway, resource-limited Docker
// container and return a structured result. Zero npm dependencies (uses the
// docker CLI via child_process). Built so an agent can verify work safely.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, isAbsolute, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

// Language presets: lang → { image, file, cmd(file) }
export const PRESETS = {
  bash:   { image: 'alpine:3.20',        file: 'main.sh', cmd: (f) => `sh ${f}` },
  sh:     { image: 'alpine:3.20',        file: 'main.sh', cmd: (f) => `sh ${f}` },
  node:   { image: 'node:22-alpine',     file: 'main.js', cmd: (f) => `node ${f}` },
  javascript: { image: 'node:22-alpine', file: 'main.js', cmd: (f) => `node ${f}` },
  python: { image: 'python:3.12-alpine', file: 'main.py', cmd: (f) => `python ${f}` },
};

const MAX_OUTPUT = 200_000;       // chars per stream before truncation
const MAX_TIMEOUT = 300_000;
// Pulling an image is not running code, so it gets its own, generous clock.
const PULL_TIMEOUT = 300_000;

export function dockerAvailable() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Opt-in run logging: when ANVIL_DB is set, record the run for `anvil serve`.
// Fire-and-forget and fully guarded — logging must never break or slow a run.
function maybeLog(opts, result) {
  if (!process.env.ANVIL_DB) return;
  import('./log.js').then((m) => { try { m.logRun({ opts, result }); } catch {} }).catch(() => {});
}

function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  if (isAbsolute(rel) || !p.startsWith(base)) throw new Error(`unsafe file path: ${rel}`);
  return p;
}

// run({ image?, lang?, code?, cmd?, files?, stdin?, timeout_ms?, network?, mem?, cpus?, secure?, noLog? })
// noLog: skip the opt-in auto-log (the caller will log it itself, e.g. to capture the new id).
export function run(opts = {}) {
  return new Promise((resolveP) => {
    const docker = dockerAvailable();
    if (!docker) return resolveP({ ok: false, error: 'docker is not available' });

    let { image, lang, code, cmd, files = {}, stdin = null, mount = null,
      timeout_ms = 30_000, network = 'none', mem = '512m', cpus = '1', secure = false, onData = null } = opts;
    timeout_ms = Math.min(Math.max(1000, timeout_ms), MAX_TIMEOUT);

    // resolve preset from lang/code
    if (lang && PRESETS[lang]) {
      const p = PRESETS[lang];
      image = image || p.image;
      if (code != null) { files = { ...files, [p.file]: code }; cmd = cmd || p.cmd(p.file); }
    }
    if (!image) image = 'alpine:3.20';
    if (!cmd) return resolveP({ ok: false, error: 'nothing to run: provide cmd, or lang+code' });

    // materialize files into a temp work dir
    const work = mkdtempSync(join(tmpdir(), 'anvil-'));
    try {
      for (const [rel, content] of Object.entries(files)) {
        const fp = safeJoin(work, rel);
        mkdirSync(dirname(fp), { recursive: true });
        writeFileSync(fp, String(content));
      }
    } catch (e) {
      rmSync(work, { recursive: true, force: true });
      return resolveP({ ok: false, error: e.message });
    }

    const startedAt = Date.now();

    // THE TIMEOUT IS FOR YOUR CODE, NOT FOR A DOWNLOAD.
    //
    // `docker run` pulls a missing image before it starts anything — so on a machine
    // that has never seen the image (which is EVERY machine, the first time) the 30s
    // code timeout was ticking while Docker downloaded 50MB of Alpine. Then anvil killed
    // it and reported a failure about the code. It worked perfectly on my laptop, where
    // the image had been cached for weeks, and failed for every new user.
    //
    // The kit's own end-to-end loop test found this on a cold CI runner, on its first run:
    //     3. anvil  run safely  ✗ exit 2: Unable to find image 'python:3.12-alpine' locally
    //
    // So: get the image FIRST, on its own clock, and say so if that is what failed.
    const have = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    if (have.status !== 0) {
      const pull = spawnSync('docker', ['pull', image], { encoding: 'utf8', timeout: PULL_TIMEOUT });
      if (pull.status !== 0) {
        rmSync(work, { recursive: true, force: true });
        return resolveP({ ok: false, image, timed_out: false, exit_code: null,
          error: `could not pull the image "${image}" (${pull.error?.code || `exit ${pull.status}`}). `
            + `anvil needs it before it can run anything, and this is not a problem with your code. `
            + `${(pull.stderr || '').trim().split('\n').pop() || ''}`.trim(),
          duration_ms: Date.now() - startedAt });
      }
    }

    const name = 'anvil_' + randomUUID().slice(0, 12);
    const args = ['run', '--rm', '-i', '--name', name,
      '--network', network === 'on' ? 'bridge' : 'none',
      '--memory', mem, '--memory-swap', mem, '--cpus', String(cpus),
      '--pids-limit', '512', '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '-v', `${work}:/work`, '-w', '/work'];
    if (mount) args.push('-v', `${resolve(mount)}:/repo:ro`);   // host dir, read-only at /repo
    if (secure) args.push('--read-only', '--tmpfs', '/tmp:rw,size=64m');
    args.push(image, '/bin/sh', '-c', cmd);

    const logOpts = { lang: opts.lang, code, cmd, image, network, mem, cpus, timeout_ms };
    const started = Date.now();
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', outTrunc = false, errTrunc = false, timedOut = false;

    // The container's output already arrives in chunks — anvil just buffered it and
    // said nothing until the end. onData hands each chunk out as it is written, so a
    // caller can watch a run happen instead of staring at a spinner. Optional, and
    // guarded: a listener that throws must not take the run down with it.
    const emit = (stream, d) => { if (!onData) return; try { onData(stream, String(d)); } catch {} };
    child.stdout.on('data', (d) => {
      emit('stdout', d);
      if (out.length < MAX_OUTPUT) out += d; else outTrunc = true;
    });
    child.stderr.on('data', (d) => {
      emit('stderr', d);
      if (err.length < MAX_OUTPUT) err += d; else errTrunc = true;
    });
    if (stdin != null) { try { child.stdin.write(String(stdin)); } catch {} }
    try { child.stdin.end(); } catch {}

    const killer = setTimeout(() => {
      timedOut = true;
      spawnSync('docker', ['kill', name], { stdio: 'ignore' });
      try { child.kill('SIGKILL'); } catch {}
    }, timeout_ms);

    child.on('close', (codeNum) => {
      clearTimeout(killer);
      rmSync(work, { recursive: true, force: true });
      const result = {
        ok: !timedOut && codeNum === 0,
        exit_code: timedOut ? null : codeNum,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        image,
        stdout: out.slice(0, MAX_OUTPUT) + (outTrunc ? '\n…[truncated]' : ''),
        stderr: err.slice(0, MAX_OUTPUT) + (errTrunc ? '\n…[truncated]' : ''),
      };
      if (!opts.noLog) maybeLog(logOpts, result);
      resolveP(result);
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      rmSync(work, { recursive: true, force: true });
      const result = { ok: false, error: `failed to start docker: ${e.message}`, duration_ms: Date.now() - started };
      if (!opts.noLog) maybeLog(logOpts, result);
      resolveP(result);
    });
  });
}
