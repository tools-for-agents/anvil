#!/usr/bin/env node
// anvil CLI — run code/commands in a throwaway Docker sandbox.
//   anvil run <lang> '<code>'              e.g. anvil run python 'print(2**10)'
//   anvil sh '<command>'                    run a shell command in alpine
//   echo '<code>' | anvil run python -      read code from stdin
//   anvil check                             docker availability + presets
//   anvil serve [--port 7930]               run-history dashboard (needs ANVIL_DB)
import { run, dockerAvailable, PRESETS, flushLog } from './run.js';
import { readFileSync } from 'node:fs';

const [, , cmd, ...rest] = process.argv;
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

// 🔑 process.exit() IS A GUILLOTINE ON EVERY PENDING PROMISE, AND THE RUN LOG IS ONE.
// `printResult` used to end with a bare process.exit(), fired the instant run() resolved — which is
// BEFORE the log's dynamic import has even loaded. So every CLI run vanished from the forge log the
// README tells you to switch on, and the "could not write the run log" warning died on the same
// line, because it lives on the discarded chain. The CLI was the one interface that dropped, so the
// log stayed plausible and was silently missing exactly the runs a human had typed.
// The exit code is worth waiting a millisecond for, and this is the only place to pay it: the call
// below is the one and only process.exit() this file executes — every other path returns into it.
// Add a second one anywhere and it exits the way the old one did, taking the record and the
// warning with it.
async function exit(code) {
  await flushLog();     // ANVIL_DB unset → resolves at once; set → the record lands before we die
  process.exit(code);
}

async function printResult(r) {
  if (r.error) { console.error('error:', r.error); return exit(1); }
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n');
  if (r.stderr) process.stderr.write('[stderr] ' + r.stderr + '\n');
  console.error(`[anvil] image=${r.image} exit=${r.exit_code}${r.timed_out ? ' TIMEOUT' : ''} ${r.duration_ms}ms`);
  return exit(r.ok ? 0 : 1);
}

(async () => {
  if (cmd === 'mcp') {
    // stdio JSON-RPC. The server starts on import: `npx @tools-for-agents/anvil mcp`
    return void await import('../mcp/mcp-server.js');
  }
  if (cmd === 'check') {
    return out({ docker: dockerAvailable() || 'unavailable', presets: Object.keys(PRESETS) });
  }
  if (cmd === 'serve') {
    const i = rest.indexOf('--port');
    const port = i >= 0 ? +rest[i + 1] : (process.env.ANVIL_PORT || 7930);
    const { serve } = await import('./server.js');
    return serve({ port });
  }
  if (cmd === 'sh') {
    const command = rest.join(' ');
    return await printResult(await run({ image: 'alpine:3.20', cmd: command }));
  }
  if (cmd === 'run') {
    const lang = rest[0];
    if (!PRESETS[lang]) { console.error('unknown lang. presets:', Object.keys(PRESETS).join(', ')); return exit(1); }
    let code = rest[1];
    if (code === '-' || code === undefined) code = readFileSync(0, 'utf8');   // stdin
    return await printResult(await run({ lang, code }));
  }
  out(`anvil — throwaway Docker sandbox for agents

  anvil run <lang> '<code>'     run a snippet (langs: ${Object.keys(PRESETS).join(', ')})
  anvil run <lang> -            read code from stdin
  anvil sh '<command>'          run a shell command in alpine
  anvil check                   docker + presets
  anvil serve [--port 7930]     run-history dashboard (needs ANVIL_DB)

Defaults: --network none, 512m memory, 1 cpu, caps dropped, 30s timeout.`);
})();
