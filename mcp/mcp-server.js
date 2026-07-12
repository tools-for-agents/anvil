#!/usr/bin/env node
// anvil — MCP server (stdio JSON-RPC). Lets agents execute code/commands in a
// throwaway, resource-limited Docker container and get a structured result, so
// work can be *verified* without touching the host. Zero npm dependencies.
import { createInterface } from 'node:readline';
import { run, dockerAvailable, PRESETS } from '../src/run.js';

const PROTOCOL = '2024-11-05';

const tools = [
  {
    name: 'anvil_run_code',
    description: 'Run a code snippet in a throwaway, sandboxed Docker container and get stdout/stderr/exit code. Use to verify logic, reproduce a bug, or check output — safely, without touching the host. Network is OFF by default.',
    inputSchema: { type: 'object', properties: {
      lang: { type: 'string', description: 'One of: bash, node, python' },
      code: { type: 'string', description: 'Source code to execute' },
      stdin: { type: 'string', description: 'Optional stdin for the program' },
      timeout_ms: { type: 'integer', description: 'Max runtime (default 30000, max 300000)' },
      network: { type: 'string', enum: ['off', 'on'], description: 'Network access (default off)' },
    }, required: ['lang', 'code'] },
    run: (a) => run({ lang: a.lang, code: a.code, stdin: a.stdin, timeout_ms: a.timeout_ms, network: a.network }),
  },
  {
    name: 'anvil_run_command',
    description: 'Run a shell command inside a container, optionally with files you supply and/or a host directory mounted read-only at /repo (e.g. run a test suite). Returns structured result.',
    inputSchema: { type: 'object', properties: {
      cmd: { type: 'string', description: 'Shell command, run with /bin/sh -c' },
      image: { type: 'string', description: 'Docker image (default alpine:3.20). e.g. node:22-alpine, python:3.12-alpine' },
      files: { type: 'object', description: 'Map of {relativePath: content} written into /work before running', additionalProperties: { type: 'string' } },
      mount: { type: 'string', description: 'Host directory to mount read-only at /repo' },
      stdin: { type: 'string' },
      timeout_ms: { type: 'integer' },
      network: { type: 'string', enum: ['off', 'on'] },
      secure: { type: 'boolean', description: 'Read-only rootfs + tmpfs /tmp' },
    }, required: ['cmd'] },
    run: (a) => run(a),
  },
  {
    name: 'anvil_check',
    description: 'Check Docker availability and list language presets.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ docker: dockerAvailable() || 'unavailable', presets: Object.keys(PRESETS) }),
  },
];

const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize')
    return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} },
      serverInfo: { name: 'anvil', version: '0.1.0' } });
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list')
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const tool = toolMap[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    // Every tool DECLARES its required arguments in inputSchema, and nothing enforced
    // them. `lens_search` with no query did not say "query is required" — it called
    // search(undefined) and died three layers down with
    //     Cannot read properties of undefined (reading 'match')
    // which is what a model got back, as if it were an answer. A schema that promises a
    // check nobody performs is worse than no schema: the client trusts it.
    const args = params?.arguments || {};
    const missing = (tool.inputSchema?.required || [])
      .filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) {
      const how = missing
        .map((k) => `"${k}"${tool.inputSchema.properties?.[k]?.description ? ` (${tool.inputSchema.properties[k].description})` : ''}`)
        .join(', ');
      return fail(id, -32602, `${tool.name}: missing required argument${missing.length > 1 ? 's' : ''} ${how}`);
    }
    // ...and the TYPES it declares, and the enums. Nothing enforced those either, and
    // unlike a missing argument they do not crash — they corrupt, quietly:
    //   kanban_create_task labels:"urgent"   → a task whose labels are the letters u,r,g…
    //   cortex_write title:{...}             → a note on disk called "[object Object]"
    //   lens_search k:"eight"                → silently ignored, and you never learn why
    // Wrong data written confidently is worse than an error, because nothing announces it.
    const props = tool.inputSchema?.properties || {};
    const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    const OK = {
      string: (v) => typeof v === 'string',
      number: (v) => typeof v === 'number' && Number.isFinite(v),
      integer: (v) => Number.isInteger(v),
      boolean: (v) => typeof v === 'boolean',
      array: (v) => Array.isArray(v),
      object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    };
    const wrong = [];
    for (const [k, spec] of Object.entries(props)) {
      const v = args[k];
      if (v === undefined || v === null) continue;
      if (spec.type && OK[spec.type] && !OK[spec.type](v)) {
        wrong.push(`"${k}" must be ${spec.type}, got ${kindOf(v)}`);
      } else if (spec.enum && !spec.enum.includes(v)) {
        wrong.push(`"${k}" must be one of ${spec.enum.join(' | ')} — got ${JSON.stringify(v)}`);
      }
    }
    if (wrong.length) return fail(id, -32602, `${tool.name}: ${wrong.join('; ')}`);
    try {
      const out = await tool.run(args);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e)); });
});
process.stderr.write('anvil MCP server ready\n');
