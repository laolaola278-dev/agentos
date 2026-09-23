# AgentOS — local autonomous agent runtime

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

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

Model output streams live: text deltas fan out as transient `model.delta` events (never persisted) and are rendered
inline by `task run` and `chat`. Long runs are kept inside the context window by automatic compaction (LLM summary of
older turns, deterministic marker without a model). Project instructions in `AGENTS.md` (or `CLAUDE.md`/`AGENTOS.md`)
are injected into the agent's system prompt.

```bash
export LLM_API_KEY=sk-...        # native tool calling required (OpenAI-compatible API)
./bin/agentos.js task run --mode agentic --goal 'add a REST endpoint /health to src/server.ts with a test'
```

Works with any OpenAI-compatible endpoint (OpenAI, DeepSeek, GLM, Ollama, vLLM — set `LLM_BASE_URL`/`LLM_MODEL`).

## Interactive session (`agentos chat`)

Type goals in a REPL; the agent works on the current directory with live streamed output:

```bash
./bin/agentos.js chat            # confirm mode: every tool call asks (y/N)
./bin/agentos.js chat --auto     # no prompts (policy + hooks still apply)
```

REPL commands: `/tools`, `/tasks`, `/auto`, `/confirm`, `/help`, `/exit`. Ctrl-C cancels the running task; without an
`LLM_API_KEY` chat explains what to set.

## Permissions

Interactive sessions default to **confirm mode**: every tool execution first asks the user. Denials surface as
`PERMISSION_DENIED` (a fatal error for the step; the task then fails like any other policy violation). Embeddings can
wire their own approval UI through runtime options:

```ts
const rt = await AgentRuntime.create({ permissionMode: "confirm", onPermissionRequest: async (req) => approve(req) });
```

## Sandbox tiers

Shell commands (terminal tool + verification engine) can run inside a pluggable sandbox:

```bash
export AGENTOS_SANDBOX=container       # or "process" / "none" (default)
# or in .agentos/config.json:
{ "sandbox": { "mode": "container", "image": "alpine:3", "memoryMb": 512, "cpus": 1, "network": false } }
```

- `container` — every command runs in an ephemeral Docker container: workspace mounted at `/workspace`, **no network**,
  dropped capabilities, memory/cpu/pids caps. Requires a reachable Docker daemon (`sandbox.onUnavailable: "degrade"`
  falls back to unsandboxed instead of failing).
- `process` — POSIX `ulimit` vmem/pid/cpu caps layered onto the command. On Windows this **fails closed**
  (`SANDBOX_UNAVAILABLE`) unless `sandbox.onUnavailable` is `"degrade"`.
- `none` — policy-only (deny-list + workspace path guard), the historic default.

The sandbox complements the command policy; it contains accidents, not adversaries (see SECURITY.md).

## Secrets vault (API keys)

Store provider keys encrypted at rest instead of env vars:

```bash
agentos secrets set LLM_API_KEY        # value from --value or piped stdin
agentos secrets list                   # names only
agentos secrets get LLM_API_KEY        # masked; add --show to reveal
agentos secrets delete LLM_API_KEY
```

`.agentos/secrets.json` is AES-256-GCM encrypted; the master key lives in `.agentos/secret.key` (0600) or
`AGENTOS_SECRET_KEY` (64 hex chars). The runtime auto-loads the vault and resolves keys in this order:
`config.llm.apiKeySecret` (vault) → provider env vars → vault default entry. `agentos doctor` shows what it resolved
(names only, never values).

## Provider profiles (GitHub Models, DeepSeek, GLM, Ollama, reverse proxies)

Instead of hand-configuring `LLM_BASE_URL`, pick a profile — it sets the endpoint, default model, key env names and
**compatibility quirks** (streaming tool-calls support, JSON mode) that the harness adapts to:

```json
{ "llm": { "provider": "github-models", "model": "openai/gpt-4o-mini" } }
```

- `github-models` — GitHub's hosted model gateway (`https://models.github.ai/inference`, key: `GITHUB_TOKEN`)
- `deepseek` / `glm` — official OpenAI-compatible endpoints (tool-call **streaming disabled** by default — their
  SSE `tool_calls` deltas are unreliable; the agentic loop falls back to non-streaming tool calling automatically)
- `ollama` — local runtime, keyless
- `custom` — your own OpenAI-compatible reverse proxy: set `baseUrl` + `apiKeySecret` (a vault entry), and
  `toolStreaming: false` when the proxy does not stream tool calls correctly

The harness also **repairs** malformed tool-call JSON (markdown fences, smart quotes, trailing commas, unbalanced
closers) before feeding errors back to the model, and emits `model.truncated` when a provider cuts a turn off at the
token limit. These profiles adapt to provider quirks — they do not bypass payment, authentication or rate limits.

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

## Skills, scoped API keys, eval loop

```bash
# Skills: markdown playbooks in .agentos/skills/*.md (frontmatter name/description),
# injected into agentic system prompts. Files matching injection/abuse patterns are rejected.
agentos skills list            # loaded + REJECTED (with reason)
agentos skills show deploy

# Scoped API keys guarding the dashboard API (auth is OFF until the first key exists):
agentos apikeys create ci --scopes tasks:read,tasks:write   # key shown ONCE, only SHA-256 stored
agentos apikeys list
curl -H "Authorization: Bearer aos_..." http://localhost:3000/api/agentos/tasks
agentos apikeys revoke key_xxx

# Deterministic eval loop: run a suite, persist the report, compare variants mechanically:
agentos eval run --suite evals.json --label baseline
agentos eval run --suite evals.json --label variant-a
agentos eval compare .agentos/evals/baseline-*.json .agentos/evals/variant-a-*.json
```

An eval case is `{ "id", "title", "goal", "acceptance?", "verification?", "budget?" }` — the scorer uses objective
evidence only (task status + acceptance + counters), so a variant comparison names regressions and improvements
mechanically. A built-in offline preset is included: `agentos eval run --preset core`. Context engineering (E1) is
built in: tool results are cleaned (head+tail strings, sliced arrays, stripped noisy keys) before they enter the model
conversation, and each agentic task keeps an external notes file (`.agentos/artifacts/<taskId>/notes.md`) that survives
conversation compaction.

## Agentic capabilities (Claude Code parity set)

- **Parallel tool calls**: consecutive read-only calls in a turn run together, bounded by `agentic.maxParallel`
  (default 4). Writes, shells and any other mutating call run alone, so one turn cannot race two edits.
  `agentic.parallelToolCalls: false` forces every call to run alone. Results stay in model order so provider
  pairing rules stay intact.
- **Subagents**: the `subagent` tool delegates self-contained work to an isolated child runtime (fresh context, no
  parent transcript, no recursive spawning) and returns a capped {status, summary} — the "context firewall" pattern.
  Optional per-subagent `instructions`. Disable with `subagent: false` in runtime options.
- **Permission policy**: `config.permissions.allow/deny` patterns (`tool`, `tool.*`, `tool.action`) — deny wins and
  hides the tool/action from the model's tool list; explicit allow skips confirm prompts; chat `/allow` adds
  session-scoped allows.
- **Workspace map**: an Aider-style repo-map (symbol extraction, budget-bounded) is injected into agentic prompts and
  researcher reports, so the model knows the project's structure before reading files.
- **Chat session resume**: turns persist to `.agentos/chat-session.json`; `agentos chat --resume` seeds the first turn
  with prior context. Slash commands come from an extensible registry (`/tools /tasks /allow /history /new /auto
  /confirm /exit`) and embedders can add their own via `extraCommands`.

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
npm run test:all         # everything above
npm run lint && npm run typecheck && npm run build
npm run bench            # regenerates BENCHMARK.md
```

Optional tiers (skipped when the environment is absent):

```bash
# real-LLM smoke: exercises the agentic loop against a live OpenAI-compatible provider
LLM_SMOKE=1 LLM_API_KEY=sk-... npm run test:smoke

# PostgreSQL regression (dashboard path) against a disposable database
TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:5432/agentos_test npm run test:integration
```

## Documents

[ARCHITECTURE.md](ARCHITECTURE.md) · [API.md](API.md) · [DEVELOPMENT.md](DEVELOPMENT.md) · [SECURITY.md](SECURITY.md) ·
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) · [BENCHMARK.md](BENCHMARK.md) · [DECISIONS.md](DECISIONS.md) · [FINAL-REPORT.md](FINAL-REPORT.md)
