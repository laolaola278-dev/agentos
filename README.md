# AgentOS — local autonomous agent runtime

AgentOS is a small, extensible **agent harness** that plans, executes, verifies, reviews and self-corrects software-engineering
tasks on your machine. It ships with:

- a framework-free TypeScript core (`src/agentos/`) — runtime, orchestrator, agents, tool runtime, event bus, checkpoints/recovery,
  verification engine, task queue, metrics;
- a **CLI** (`bin/agentos.js`);
- a **Next.js dashboard** (tasks, live event timeline, agents, tools, tests, metrics) backed by PostgreSQL;
- JSONL + SQLite (`node:sqlite`) persistence for offline/local use, PostgreSQL (Drizzle) for the dashboard;
- unit / integration / e2e / recovery / stress / chaos test suites and a benchmark.

Without an LLM key the planner is **deterministic** (a small goal DSL, or explicit `steps`); with `LLM_API_KEY` set,
an OpenAI-compatible model plans free-form goals, proposes fixes and performs an additional independent review.
Either way, a task can only complete with objective evidence (verification commands + reviewer PASS).

## Agentic mode (LLM tool-calling loop)

Modeled after the Claude Code / Codex core loop, a task can run in **agentic mode**, where the model drives the tool
registry directly: it proposes tool calls each turn, observes the structured results and decides the next action until
it declares the goal met. The harness stays in charge — budgets, per-call checkpoints, the verification engine and the
independent reviewer still gate completion with objective evidence.

```bash
export LLM_API_KEY=sk-...        # native tool calling required (OpenAI-compatible API)
./bin/agentos.js task run --mode agentic --goal 'add a REST endpoint /health to src/server.ts with a test'
```

Works with any OpenAI-compatible endpoint (OpenAI, DeepSeek, GLM, Ollama, vLLM — set `LLM_BASE_URL`/`LLM_MODEL`).

## Hooks (`.agentos/config.json`)

Lifecycle hooks in the style of Claude Code: a JSON payload describing the event goes to the hook command's stdin;
environment carries `AGENTOS_HOOK_EVENT` / `AGENTOS_TOOL` / `AGENTOS_ACTION` / `AGENTOS_TASK_ID`.

| event | exit code 2 | other non-zero |
|---|---|---|
| `pre_tool_call` | **blocks the tool call** (`HOOK_BLOCKED`, stderr is the reason) | recorded, non-blocking |
| `post_tool_call` | non-blocking | recorded, non-blocking |
| `task_completed` / `task_failed` | non-blocking | recorded, non-blocking |

```json
{
  "hooks": {
    "pre_tool_call": [{ "match": "terminal.*", "command": "node scripts/guard-terminal.js" }],
    "post_tool_call": [{ "match": "filesystem.write", "command": "node scripts/audit-write.js" }],
    "task_completed": [{ "command": "node scripts/notify.js" }]
  }
}
```

`match` is `*` (default), `tool`, `tool.*` or `tool.action`.

## MCP servers (Model Context Protocol)

External tools join the registry at startup via the stdio transport, like Claude Code / Codex:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }
  }
}
```

Each MCP tool becomes a registry tool named `mcp_<server>_<tool>` with a single `call` action, usable in `steps`,
the goal DSL `git:`-style plans and agentic mode. A down server emits `mcp.failed` and never blocks the runtime.

## Install

```bash
npm install                       # Node >= 22.13 (node:sqlite), git, bash
cp .env.example .env 2>/dev/null || true   # DATABASE_URL is only required for the dashboard / --store pg
```

## Run a task from the CLI (no database needed)

```bash
# initialise .agentos/ (SQLite store + JSONL mirror) in the current directory
./bin/agentos.js init

# plan → execute → verify → review → COMPLETED
./bin/agentos.js task run --goal 'write hello.txt: hello world
run: cat hello.txt
verify: grep -q hello hello.txt
check contains hello.txt: hello'

./bin/agentos.js task status            # list tasks
./bin/agentos.js task logs <id>         # event log (--follow, --type tool.)
./bin/agentos.js task result <id>       # plan, step results, verification evidence, review
./bin/agentos.js task pause <id>        # from another terminal — checkpointed, resumable
./bin/agentos.js task resume <id>
./bin/agentos.js recover                # after a crash: resume every interrupted task from its checkpoint
./bin/agentos.js doctor
./bin/agentos.js tools list
./bin/agentos.js agent list
./bin/agentos.js metrics --prometheus
./bin/agentos.js --help
```

Explicit steps and budgets:

```bash
./bin/agentos.js task run --goal 'n/a' \
  --step 'filesystem.write:{"path":"a.txt","content":"1"}' \
  --step 'terminal.execute:{"command":"cat a.txt"}' \
  --verify 'test -f a.txt' --max-retries 2 --timeout 60000
```

Goal DSL (one instruction per line): `write <path>: <content>`, `append <path>: <content>`, `mkdir <path>`, `delete <path>`,
`run: <command>`, `fetch <url>`, `git: <action> {json}`, `verify: <command>`, `check exists <path>`,
`check contains <path>: <text>`, `check not-contains <path>: <text>`, `check command: <command>`. Lines starting with `#` are comments.

## Dashboard (PostgreSQL)

```bash
# .env: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
npx drizzle-kit push          # creates agentos_tasks / agentos_events / agentos_checkpoints
npm run dev                   # http://localhost:3000
```

The dashboard's runtime lives in the Next.js server process, recovers interrupted tasks on boot, and polls the store so tasks
created by `./bin/agentos.js --store pg task create ...` are picked up too. See [API.md](API.md).

## Optional LLM

```bash
export LLM_API_KEY=...            # or OPENAI_API_KEY
export LLM_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible endpoint (Ollama, vLLM, DeepSeek, GLM...)
export LLM_MODEL=gpt-4o-mini
```

See [.env.example](.env.example) for all variables (dashboard `DATABASE_URL`, timeouts, retries).

## Test

```bash
npm test                 # unit + integration
npm run test:e2e         # CLI end-to-end
npm run test:recovery    # SIGKILL mid-task → restart → resume
npm run test:stress      # hundreds of tasks, thousands of events, concurrent tool calls
npm run test:chaos       # failing store, tool crashes, deleted workdir, partial writes
npm run test:all
npm run lint && npm run typecheck && npm run build
npm run bench            # regenerates BENCHMARK.md
```

## Documents

[ARCHITECTURE.md](ARCHITECTURE.md) · [API.md](API.md) · [DEVELOPMENT.md](DEVELOPMENT.md) · [SECURITY.md](SECURITY.md) ·
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) · [BENCHMARK.md](BENCHMARK.md) · [DECISIONS.md](DECISIONS.md) · [FINAL-REPORT.md](FINAL-REPORT.md)
