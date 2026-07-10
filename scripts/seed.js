// Seed the anvil run log with a spread of example runs so `anvil serve` shows a
// real forge log without needing Docker. Deterministic. Requires ANVIL_DB.
//   ANVIL_DB=./.anvil/runs.db node scripts/seed.js
import { logRun } from '../src/log.js';

const runs = [
  { opts: { lang: 'python', code: 'print(sum(range(1, 101)))', mem: '512m', cpus: '1', timeout_ms: 30000 },
    result: { ok: true, exit_code: 0, timed_out: false, duration_ms: 612, image: 'python:3.12-alpine', stdout: '5050\n', stderr: '' } },
  { opts: { lang: 'node', code: "console.log(JSON.stringify({ ok: true, node: process.version }))", mem: '512m', cpus: '1', timeout_ms: 30000 },
    result: { ok: true, exit_code: 0, timed_out: false, duration_ms: 438, image: 'node:22-alpine', stdout: '{"ok":true,"node":"v22.11.0"}\n', stderr: '' } },
  { opts: { lang: 'bash', code: 'echo "building…"; echo "missing file" 1>&2; exit 3', mem: '512m', cpus: '1', timeout_ms: 30000 },
    result: { ok: false, exit_code: 3, timed_out: false, duration_ms: 205, image: 'alpine:3.20', stdout: 'building…\n', stderr: 'missing file\n' } },
  { opts: { cmd: 'apk add --no-cache curl >/dev/null && curl -s https://example.com | head -c 40', network: 'on', mem: '512m', cpus: '1', timeout_ms: 30000 },
    result: { ok: true, exit_code: 0, timed_out: false, duration_ms: 2841, image: 'alpine:3.20', stdout: '<!doctype html>\n<html>\n<head>\n    <title>Ex', stderr: '' } },
  { opts: { lang: 'python', code: 'import time\nwhile True:\n    time.sleep(1)', mem: '512m', cpus: '1', timeout_ms: 5000 },
    result: { ok: false, exit_code: null, timed_out: true, duration_ms: 5003, image: 'python:3.12-alpine', stdout: '', stderr: '' } },
  { opts: { lang: 'python', code: 'data = [x*x for x in range(10)]\nprint(data)\nassert sum(data) == 285', mem: '256m', cpus: '0.5', timeout_ms: 15000 },
    result: { ok: true, exit_code: 0, timed_out: false, duration_ms: 559, image: 'python:3.12-alpine', stdout: '[0, 1, 4, 9, 16, 25, 36, 49, 64, 81]\n', stderr: '' } },
  { opts: { cmd: 'node -e "process.exit(0)"; nonexistent-binary', network: 'none', mem: '512m', cpus: '1', timeout_ms: 30000 },
    result: { ok: false, exit_code: 127, timed_out: false, duration_ms: 331, image: 'node:22-alpine', stdout: '', stderr: '/bin/sh: nonexistent-binary: not found\n' } },
];

let n = 0;
for (const r of runs) { logRun(r); n++; }
console.log(`Seeded anvil run log with ${n} runs.`);
