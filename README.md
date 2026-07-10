# ⚒ anvil

[![ci](https://github.com/tools-for-agents/anvil/actions/workflows/ci.yml/badge.svg)](https://github.com/tools-for-agents/anvil/actions/workflows/ci.yml)

**A throwaway Docker sandbox for agents.**

Run code or shell commands in a **resource-limited, network-isolated, single-use container** and get back a structured result — `stdout`, `stderr`, `exit_code`, `timed_out`, `duration_ms`. So an agent can *verify* its work, reproduce a bug, or check output **without ever touching the host**.

Part of [`tools-for-agents`](https://github.com/tools-for-agents). **Zero npm dependencies** — drives the `docker` CLI directly.

---

## Safe by default

Every run is launched with:

- `--network none` — no network unless you opt in (`network: "on"`)
- `--memory 512m --cpus 1 --pids-limit 512` — bounded resources
- `--cap-drop ALL --security-opt no-new-privileges` — minimal privileges
- `--rm` ephemeral container, work dir is a fresh temp mount, removed after
- a hard timeout (default 30s, max 300s) that `docker kill`s the container
- optional `secure: true` → read-only rootfs + tmpfs `/tmp`

## CLI

```bash
node src/cli.js check                          # docker version + presets
node src/cli.js run python 'print(2**10)'      # → 1024
node src/cli.js run node 'console.log(6*7)'    # → 42
echo 'print("hi")' | node src/cli.js run python -
node src/cli.js sh 'apk info 2>/dev/null | head'
```

## Run history (`anvil serve`)

![anvil serve — the forge log: every sandbox run with its code, output, exit status and resource limits](docs/web-view.png)

anvil is stateless by default. Set **`ANVIL_DB`** to record every run, then browse them in a dashboard:

```bash
export ANVIL_DB=./.anvil/runs.db          # opt in to the run log
node src/cli.js run python 'print(2**10)'  # …runs are now recorded
node src/cli.js serve                       # → http://localhost:7930  (--port to change)
```

A zero-dependency **forge log** of what the sandbox executed:

- **Run list** — every execution with its language, status (ok / failed / timed out), exit code and duration, colour-coded at a glance.
- **Run detail** — the exact code or command, full **stdout** and **stderr**, and the resource limits it ran under (network, memory, cpus, timeout). Each block has a one-click **⧉ copy** so you can lift the code or its output straight to the clipboard.
- **Compare two runs** — hit **⇄ compare**, pick any two runs, and see a side-by-side line diff of their code, stdout and stderr, plus every limit that changed (`took 258ms → 559ms`, `mem 512m → 256m`).
- **New run** — hit **＋ new run** to type a snippet (bash / node / python), execute it in a fresh sandbox right from the dashboard, and watch the result open in the detail. Runs go through the same guarded, network-off container as the CLI (⌘/Ctrl+Enter to run).
- **Re-run** — hit **↻ re-run** on any run to re-execute its exact code and limits in a fresh sandbox; the new run is logged and opened, so you can compare it against the original.
- **Filters + stats** — narrow to failures, see ok/failed counts and average duration.

Logging is opt-in, fire-and-forget and fully guarded — it never slows or breaks a run. Try the demo without Docker: `ANVIL_DB=./.anvil/runs.db node scripts/seed.js` then `anvil serve`.

## MCP server (for agents)

```jsonc
{
  "mcpServers": {
    "anvil": { "command": "node", "args": ["/abs/path/to/anvil/mcp/mcp-server.js"] }
  }
}
```

### Tools

| Tool | Use it to… |
|---|---|
| `anvil_run_code` | Run a `bash` / `node` / `python` snippet, get structured output. |
| `anvil_run_command` | Run a shell command with supplied `files` and/or a host dir mounted **read-only** at `/repo` (e.g. run a test suite). |
| `anvil_check` | Docker availability + language presets. |

### Example: verify a repo's syntax without copying it

```json
{ "name": "anvil_run_command",
  "arguments": { "image": "node:22-alpine", "mount": "/path/to/repo/src",
                 "cmd": "node --check /repo/core.js && echo OK" } }
```

## Result shape

```json
{ "ok": true, "exit_code": 0, "timed_out": false, "duration_ms": 178,
  "image": "python:3.12-alpine", "stdout": "...", "stderr": "" }
```

## The agent toolkit

`anvil` is the **execute/verify** leg of the `tools-for-agents` toolkit:

- 🛰️ [**agent-hq**](https://github.com/tools-for-agents/agent-hq) — coordinate (memory, kanban, dashboard)
- 🔎 [**lens**](https://github.com/tools-for-agents/lens) — read code (token-budgeted retrieval)
- ⚒ **anvil** — run safely (sandboxed execution)
- 🧠 [**cortex**](https://github.com/tools-for-agents/cortex) — remember (Obsidian-compatible second brain)
- 🧭 [**scout**](https://github.com/tools-for-agents/scout) — read the web (clean, cached markdown)
- 🎯 [**recall**](https://github.com/tools-for-agents/recall) — recall it all (one query across every store)

MIT licensed.
