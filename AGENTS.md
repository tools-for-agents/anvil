# AGENTS.md — anvil

⚒ **A throwaway Docker sandbox for agents.** Run code or commands in an isolated, resource-limited,
network-off container and get structured results back — so an agent verifies work without touching the host.
CLI + web + MCP. Part of [tools-for-agents](https://github.com/tools-for-agents).

## Setup

```bash
node --version                          # 22+ required. Nothing to install.
docker info                             # Docker must be running — anvil is a shell around it
npm test                                # = node --test (docker-dependent tests skip without it)
node src/cli.js check                   # docker + presets: run this first
node src/cli.js run python 'print(1+1)' # langs: bash, sh, node, javascript, python
node src/cli.js run python -            # read the code from stdin
node src/cli.js sh 'ls -la'             # a shell command in alpine
node src/cli.js serve --port 7930       # the run log (real, but absent from --help)
npm run mcp                             # the MCP server, stdio
```

Defaults every run inherits: `--network none`, 512m memory, 1 cpu, caps dropped, 30s timeout.

**Zero runtime dependencies, and that is a hard rule.** No `dependencies` in `package.json`, ever — anvil
shells out to `docker` rather than pulling in a client library. Node 22+ gives you `node:sqlite`.

| Env | For |
|---|---|
| `ANVIL_DB` | the run log — **always redirect this in tests** |
| `ANVIL_PORT` | serve port (default 7930) |
| `ANVIL_CORTEX_URL` | optional cortex link-up |

## The rules this repo is built on

**1. The sandbox's promises are the product.** Network off, memory and CPU capped, a hard timeout, and the
container is thrown away. Every one of those is a claim someone will rely on to run code they have not read.
If you touch container setup, write the test that proves the promise still holds — a sandbox that *usually*
has the network off is not a sandbox.

**2. Only the picture is evidence.** Run [iris](https://github.com/tools-for-agents/iris) against any UI
change and *look at the shot*. Audit `phone,tablet,desktop`, both themes, with `--hover` — the run log's rows
raise under the pointer, and the ink did not survive it until someone rendered that state.

**3. Open the doors.** The run detail panel is behind a click; nothing rendered it until a gate did, and there
was a bug in it. Drive the page with `--pre` and look.

**4. Bytes are not text.** A process's output is arbitrary bytes: invalid UTF-8, a lone surrogate, 50MB of
noise, a container that dies mid-write. Every one of those must come back as a structured, honest result —
not a crash, and not tidy-looking nonsense.

## Tests

`npm test` — `node --test`. Docker-dependent tests guard on Docker being present, but **CI runs them for
real** — a green local run that skipped every container test proves nothing.

## CI

`test` · `mutants` · `look` · `look-detail` · `first-run` · `states` · `dead-api` · `slow-api` ·
`refused-write`

- **`mutants`** — every canary must die. Push and read CI.
- **`look*`** are iris gates, seeded with real runs first — an empty log cannot be wrong.

## Commits

Lowercase, `area: what changed and why it mattered` — `core:`, `ui:`, `ci:`, `fix:`. Say what was actually
wrong, including what fooled you. The git log is this project's real documentation.
