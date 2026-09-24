// anvil core — run code/commands in a throwaway, resource-limited Docker
// container and return a structured result. Zero npm dependencies (uses the
// docker CLI via child_process). Built so an agent can verify work safely.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, isAbsolute, normalize, sep } from 'node:path';
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
// A bad timeout_ms ('abc' / NaN / 0 / negative) must not slip through. NaN SURVIVES Math.max/min
// (Math.max(1000, NaN) === NaN), and setTimeout(fn, NaN) fires IMMEDIATELY — so an unclamped bad
// value kills a perfectly good run on the spot and reports it as a timeout. Coerce to the default
// first (`|| 30_000` catches NaN and 0), then clamp to [1000, MAX_TIMEOUT].
export const clampTimeout = (ms) => Math.min(Math.max(1000, +ms || 30_000), MAX_TIMEOUT);

// A container killed by a signal exits 128+n (POSIX). That number alone is opaque: 137 and 139 look
// like ordinary failures but mean "force-killed" and "segfault" — and the run that hit them usually
// printed NOTHING to stderr, because it was killed mid-word. Decode the code to the signal NAME so the
// result still says HOW it died. Linux numbers, since every anvil container is Linux. null for a normal
// exit (≤128 is a real program exit code, not a signal). Docker-free by construction, so it is unit-tested.
const SIGNALS = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT',
  7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM' };
export function signalName(code) {
  if (!Number.isInteger(code) || code <= 128) return null;
  const n = code - 128;
  return SIGNALS[n] || `SIG${n}`;   // an unmapped signal is still named, never swallowed
}

// Collect a child process stream into a capped, UTF-8-decoded string. setEncoding is LOAD-BEARING:
// without it each `data` chunk arrives as a Buffer decoded on its own, so a multi-byte character
// (an emoji, 你好, café) split across a chunk boundary — which docker does, at arbitrary byte offsets —
// becomes mojibake at the seam, in BOTH the returned output AND the live onData stream. Node's
// StringDecoder (via setEncoding) holds the incomplete tail bytes until the character is whole.
// Exported so the decode can be exercised without a container (docker is not needed to test bytes).
export function collect(stream, kind, onChunk, cap) {
  stream.setEncoding('utf8');
  let text = '', truncated = false;
  stream.on('data', (d) => {
    onChunk(kind, d);
    // Cap the KEPT text and SAY when we cut — never a silent truncation. The old form only set the
    // flag when a chunk arrived AFTER the cap was already reached, so a single chunk larger than the
    // cap was trimmed with no marker at all. Check the length we actually hold.
    if (truncated) return;
    text += d;
    if (text.length > cap) { text = text.slice(0, cap); truncated = true; }
  });
  return () => text + (truncated ? '\n…[truncated]' : '');
}
// Pulling an image is not running code, so it gets its own, generous clock.
const PULL_TIMEOUT = 300_000;

// "docker is not available" was the whole message. It names no cause, suggests no action,
// and — worse — it CONFLATES TWO COMPLETELY DIFFERENT SITUATIONS WITH DIFFERENT FIXES:
//
//   · Docker is not installed        → install it
//   · Docker is installed and the daemon is not running → start it
//
// Those are not the same problem, and telling a user "not available" sends them to look
// for the wrong one. (I hit the second myself, twice, in a single day: Docker Desktop had
// quit, and anvil said the same six words it says to someone who has never installed it.)
//
// They are trivially distinguishable: no binary at all is ENOENT from the spawn; a dead
// daemon is a binary that runs and complains that it cannot connect. So say which.
export function dockerStatus() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (r.error?.code === 'ENOENT') {
    return { ok: false, reason: 'not-installed',
      error: 'Docker is not installed on this machine. anvil runs your code inside a throwaway container, '
        + 'so it needs one — this is not a problem with your code. '
        + 'Install Docker Desktop (macOS/Windows) or the docker engine (Linux): https://docs.docker.com/get-docker/' };
  }
  if (r.status === 0) return { ok: true, version: (r.stdout || '').trim() };

  const said = (r.stderr || '').trim().split('\n')[0];
  if (/cannot connect to the docker daemon|daemon (is )?not running|docker daemon running/i.test(said)) {
    return { ok: false, reason: 'daemon-down',
      error: 'Docker is installed, but the daemon is not running — a different problem from a missing Docker, '
        + 'and a different fix. Start it: open Docker Desktop (macOS/Windows), or `sudo systemctl start docker` (Linux).'
        + (said ? ` (docker said: ${said})` : ''), detail: said };
  }
  return { ok: false, reason: 'unknown',
    error: `docker is installed but did not answer${said ? `: ${said}` : ''}. anvil needs it to run anything.`,
    detail: said };
}

/** Kept for callers that only want the version string (or null). */
export function dockerAvailable() {
  const s = dockerStatus();
  return s.ok ? s.version : null;
}

// Opt-in run logging: when ANVIL_DB is set, record the run for `anvil serve`.
// Fire-and-forget and fully guarded — logging must never break or slow a run. That part is right: the
// run is the product, the log is bookkeeping, and a broken log must not cost you a working sandbox.
//
// 🔑 BUT SILENCE IS NOT THE SAME AS NON-FATAL. This used to `catch {}` and say nothing, so a run that
// FAILED TO LOG simply vanished from the history: `anvil runs` showed fewer runs than had happened, and
// nothing anywhere said why. You set ANVIL_DB because you wanted a record — and the one time the record
// silently isn't kept is the one time you needed it. Warn, do not throw. (stderr, never stdout: stdout
// is the MCP protocol, and one stray line on it desyncs the session.)
//
// 🔑 AND A FIRE-AND-FORGET WRITE IS A WRITE THE NEXT LINE CAN THROW AWAY. `import('./log.js')` is
// asynchronous: when run() resolves, the INSERT has not merely not finished — it has not STARTED.
// A caller that ends the process the instant it gets its result kills the pending promise, and
// process.exit() is exactly that guillotine. src/cli.js ended `printResult` with it, so EVERY
// `anvil run` / `anvil sh` was dropped from the forge log — the .anvil/ directory the README tells
// you to set was never even created — while `anvil serve` answered `{"count":0,"runs":[]}` with
// `docker: ok` beside it. Worse, the same line discarded the `.catch(warn)` BELOW, so the guard
// written for exactly this silence was disabled by the silence it was guarding. Both failed
// together, which is why it stayed invisible: the MCP server, the library path and the web view
// are long-lived, so they logged fine, and the log looked populated and was quietly missing a
// subset of its history.
//
// So the fix is not "the CLI waits 250ms". A fire-and-forget write needs a JOIN POINT, and this is
// it: every attempt is tracked, flushLog() awaits them, and any process that exits ahead of one
// SAYS SO on the way out. A lost record must never be a quiet record.
let _warned = false;
const _pending = new Set();
let _exitGuard = false;

// The last word, on the way out. It runs on 'exit' — which process.exit() DOES fire — so an exit
// that beats a write is announced instead of swallowed. fs.writeSync(2), not process.stderr.write:
// on macOS a piped stderr write is asynchronous, and process.exit() would discard the message about
// the discarded write. Nothing async is possible here; naming the loss is.
function armExitGuard() {
  if (_exitGuard) return;
  _exitGuard = true;
  // The path as it stood when the first write was queued, not as it stands at exit: log.js freezes
  // its DB_PATH at import, so a process that edits process.env afterwards would have us name a file
  // these writes were never going for — or print `undefined` for a log that plainly exists.
  const dbPath = process.env.ANVIL_DB;
  process.on('exit', () => {
    if (!_pending.size) return;
    try {
      writeSync(2, `anvil: exited before ${_pending.size} run(s) reached the log at ${dbPath}`
        + ` — they were NOT recorded, so the history is INCOMPLETE.\n`
        + `  The runs themselves were fine. A caller that ends the process must await flushLog()`
        + ` from src/run.js first (the CLI does).\n`);
    } catch { /* fd 2 is gone; there is nowhere left to say it */ }
  });
}

/**
 * Await every in-flight run-log write. Anything about to END THE PROCESS — the CLI, a script that
 * calls process.exit() — must await this first, or it discards the record AND the warning about it.
 * Resolves immediately when ANVIL_DB is unset (anvil is stateless then) or nothing is in flight.
 */
export async function flushLog() {
  while (_pending.size) await Promise.allSettled([..._pending]);   // a write started while we waited still counts
}

function maybeLog(opts, result) {
  if (!process.env.ANVIL_DB) return;
  const warn = (e) => {
    if (_warned) return;            // once per process — a warning repeated 400 times is noise, not news
    _warned = true;
    // writeSync(2) for the same reason as the exit guard: this line is the ONLY evidence that a run
    // was not recorded, and it must survive a caller that exits the moment it has its result.
    try {
      writeSync(2, `anvil: could not write the run log at ${process.env.ANVIL_DB} — ${e.message || e}\n`
        + `  Your runs still WORK; they are just not being recorded. Further log failures are silent.\n`);
    } catch { /* nowhere to say it */ }
  };
  // ONE warn path, not two. Every realistic failure — a corrupt db, an unwritable path, a schema
  // conflict — throws when log.js is imported (it opens the db at module load), before logRun even
  // runs; and if logRun itself throws, the rejected promise lands on the same .catch. An inner
  // try/catch that warned separately was redundant AND untestable — the reachable failures never hit
  // it. One path is one thing to test, and nothing is swallowed in silence.
  const p = import('./log.js')
    .then((m) => {
      m.logRun({ opts, result });
      _pending.delete(p);      // the row is DOWN — see the drain note below for why that is here
    })
    .catch(warn);
  _pending.add(p);
  // 🔑 THE DRAIN IS ITS OWN STATEMENT, AND IT HAS TO STAY ONE. The line above — indented, ending in
  // a semicolon — is the anchor for mutants canary #6, the canary that rewrites it to swallow the
  // error and demands the suite go RED, i.e. the one thing proving a failed log still SAYS so. The
  // first shape of this fix chained `.finally(…)` onto it; the anchor then matched 0×, and mutants
  // scores a drifted anchor as a hard failure, never a skip. The gate goes red — and worse, had it
  // landed, nothing would have been watching the guard this whole change exists to strengthen.
  // Chain nothing onto it, and do not quote it verbatim in a comment either: TWO matches fails the
  // same way as none — which is how the second draft of this very comment broke it again.
  // test/canaries.test.js checks every anchor in ten milliseconds; it caught both mistakes.
  //
  // Two drain points, on purpose, because they answer two different questions:
  //   · inside .then — the INSERT has returned, so this run can no longer be CLAIMED LOST. The exit
  //     guard below prints a count, and a count that says "NOT recorded" about a written row is the
  //     same confident lie as the empty log this fix removes.
  //   · here — the failure path, where the .then never ran. It fires only after `warn` has had its
  //     say, so nothing can exit between "the write failed" and "somebody said so".
  // Set.delete on an absent member is a no-op, so the success path simply passes through twice.
  p.finally(() => _pending.delete(p));
  armExitGuard();
}

// The caller controls the `files` map — including the keys — and these get written to the HOST
// filesystem, BEFORE the container starts. So a key like `../../etc/cron.d/evil` is an attempt to
// write attacker-chosen bytes outside the sandbox's work dir, and it must be refused here, not left
// to Docker (by the time Docker runs, the file is already on the host).
//
// `startsWith(base)` alone is the sibling-directory hole I fixed in the five web servers: base
// /tmp/anvil-abc also prefixes /tmp/anvil-abc-evil, so `../anvil-abc-evil/f` would slip through.
// Require the separator — inside the work dir, not merely spelled like it.
export function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  if (isAbsolute(rel) || (p !== base && !p.startsWith(base + sep))) throw new Error(`unsafe file path: ${rel}`);
  return p;
}

// run({ image?, lang?, code?, cmd?, files?, stdin?, timeout_ms?, network?, mem?, cpus?, secure?, noLog? })
// noLog: skip the opt-in auto-log (the caller will log it itself, e.g. to capture the new id).
export function run(opts = {}) {
  return new Promise((resolveP) => {
    let { image, lang, code, cmd, files = {}, stdin = null, mount = null,
      timeout_ms = 30_000, network = 'none', mem = '512m', cpus = '1', secure = false, onData = null } = opts;
    timeout_ms = clampTimeout(timeout_ms);

    // resolve preset from lang/code
    if (lang && PRESETS[lang]) {
      const p = PRESETS[lang];
      image = image || p.image;
      if (code != null) { files = { ...files, [p.file]: code }; cmd = cmd || p.cmd(p.file); }
    } else if (lang && !cmd) {
      // A lang that is not a preset, with no explicit cmd to fall back to, is a MISTAKE — not "nothing to
      // run". The CLI already says so; the core (the MCP path, anvil_run_code) fell through to the generic
      // error and sent an agent hunting for the cmd it already provided. Name the bad lang and the real ones.
      return resolveP({ ok: false, error: `unknown lang "${lang}" — presets: ${Object.keys(PRESETS).join(', ')} (or pass cmd + image to run something custom)` });
    }
    if (!image) image = 'alpine:3.20';
    if (!cmd) return resolveP({ ok: false, error: 'nothing to run: provide cmd, or lang+code' });
    // The caller's mistake first, the machine's state second. With Docker down, an unknown lang used to
    // come back as "docker is not running" — true, and not the thing the caller got wrong; they fix
    // Docker, rerun, and only then learn the lang never existed. Arguments are judged before the daemon.
    const docker = dockerStatus();
    if (!docker.ok) return resolveP({ ok: false, docker: docker.reason, error: docker.error });

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

    // RUN AS THE USER, NOT AS ROOT — and this is a bug fix, not a hardening flourish.
    //
    // `--cap-drop ALL` takes away CAP_DAC_OVERRIDE, which is the capability that lets
    // root ignore file permissions. The work dir is mkdtemp's 0700, owned by the host
    // user. So container-root could not read the file anvil had just written:
    //
    //     python: can't open file '/work/main.py': [Errno 13] Permission denied
    //
    // On macOS this never showed, because Docker Desktop's file-sharing layer launders
    // ownership. On Linux — every CI runner, every server, every place this would
    // actually be deployed — anvil could not run code from a file AT ALL. It was broken
    // for its entire life on the only platform that matters, and its own test suite went
    // green on Linux the whole time, because those tests pass `cmd` and never write a file.
    //
    // Matching the container's uid to the host's fixes it at the root: the process owns
    // the files it is given, no permissions need loosening, and nothing runs as root.
    if (typeof process.getuid === 'function') {
      args.push('--user', `${process.getuid()}:${process.getgid()}`);
    }
    if (mount) args.push('-v', `${resolve(mount)}:/repo:ro`);   // host dir, read-only at /repo
    if (secure) args.push('--read-only', '--tmpfs', '/tmp:rw,size=64m');
    args.push(image, '/bin/sh', '-c', cmd);

    const logOpts = { lang: opts.lang, code, cmd, image, network, mem, cpus, timeout_ms };
    const started = Date.now();
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let timedOut = false;

    // The container's output already arrives in chunks — anvil just buffered it and
    // said nothing until the end. onData hands each chunk out as it is written, so a
    // caller can watch a run happen instead of staring at a spinner. Optional, and
    // guarded: a listener that throws must not take the run down with it.
    const emit = (stream, d) => { if (!onData) return; try { onData(stream, String(d)); } catch {} };
    const getOut = collect(child.stdout, 'stdout', emit, MAX_OUTPUT);
    const getErr = collect(child.stderr, 'stderr', emit, MAX_OUTPUT);
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
        stdout: getOut(),
        stderr: getErr(),
      };
      // Killed by a signal, and not by our own timeout? Name it — a bare 137/139 with empty stderr is a
      // dead end. And for a SIGKILL, name the cause nobody guesses: under a memory cap it is almost always
      // the OOM killer. Said as a likelihood, not a claim, with the fix in the sentence.
      const sig = timedOut ? null : signalName(codeNum);
      if (sig) {
        result.signal = sig;
        if (sig === 'SIGKILL') {
          result.hint = `killed with SIGKILL — under anvil's ${mem} memory cap this is most often the `
            + `out-of-memory killer; reduce the memory the code uses, or raise the memory limit.`;
        }
      }
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
