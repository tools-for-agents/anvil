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

export function dockerAvailable() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  if (isAbsolute(rel) || !p.startsWith(base)) throw new Error(`unsafe file path: ${rel}`);
  return p;
}

// run({ image?, lang?, code?, cmd?, files?, stdin?, timeout_ms?, network?, mem?, cpus?, secure? })
export function run(opts = {}) {
  return new Promise((resolveP) => {
    const docker = dockerAvailable();
    if (!docker) return resolveP({ ok: false, error: 'docker is not available' });

    let { image, lang, code, cmd, files = {}, stdin = null, mount = null,
      timeout_ms = 30_000, network = 'none', mem = '512m', cpus = '1', secure = false } = opts;
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

    const started = Date.now();
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', outTrunc = false, errTrunc = false, timedOut = false;

    child.stdout.on('data', (d) => {
      if (out.length < MAX_OUTPUT) out += d; else outTrunc = true;
    });
    child.stderr.on('data', (d) => {
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
      resolveP({
        ok: !timedOut && codeNum === 0,
        exit_code: timedOut ? null : codeNum,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        image,
        stdout: out.slice(0, MAX_OUTPUT) + (outTrunc ? '\n…[truncated]' : ''),
        stderr: err.slice(0, MAX_OUTPUT) + (errTrunc ? '\n…[truncated]' : ''),
      });
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      rmSync(work, { recursive: true, force: true });
      resolveP({ ok: false, error: `failed to start docker: ${e.message}` });
    });
  });
}
