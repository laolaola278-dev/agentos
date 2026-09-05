# ARCHITECTURE

```
                 CLI (src/agentos/cli.ts, bin/agentos.js)        Next.js dashboard + API (src/app)
                                 │                                          │
                                 └──────────────► AgentRuntime ◄────────────┘   (src/agentos/runtime.ts)
                                                     │
        ┌───────────────┬───────────────┬────────────┼──────────────┬───────────────┐
        ▼               ▼               ▼            ▼              ▼               ▼
   TaskQueue        EventBus       ToolRegistry  Orchestrator   MetricsCollector  Persistence
 (priority, deps)  (emit/sub/      (fs, terminal, (lifecycle     (json/prometheus) (memory | file+JSONL |
                    stream/replay)  process, git,   state machine)                  sqlite | postgres)
                                    http)              │
                                                       ▼
                      Planner → Executor → Tester → Reviewer  ⟲ Debugger   (+ Researcher, Integrator)
                                                       │
                                              VerificationEngine
```

## Modules (src/agentos)

| File | Responsibility |
|---|---|
| `types.ts` | All shared contracts: Task/TaskSpec/Budget, StepSpec/StepResult, Tool*, AgentEvent, Checkpoint, VerificationResult, ReviewResult, Diagnosis, errors |
| `security.ts` | Secret redaction (keys + value patterns + env values), safe child env allowlist, `resolveSafePath` (traversal + symlink escape), destructive-command policy, URL policy, git-arg injection guard |
| `persistence.ts` | `Persistence` interface + `MemoryPersistence`, `FilePersistence` (JSONL events, JSON tasks/checkpoints, atomic writes, corrupt-line tolerant), `SqlitePersistence` (`node:sqlite`, WAL) |
| `persistence-pg.ts` | `PgPersistence` via Drizzle (`src/db/schema.ts`) |
| `events.ts` | `EventBus`: redact → sequence → persist → fan-out; bounded retry buffer when the store fails; `stream()` async iterator; `replay()` |
| `tools/registry.ts` | `ToolRegistry.execute`: timeout + cancellation (AbortSignal), output truncation, structured `ToolOutput`, `tool.*` events. Never throws |
| `tools/filesystem.ts` | read/write/append/edit/apply_patch/patch/delete/move/copy/list/search/mkdir/stat/exists inside the workdir (14 actions); binary detection, size caps, atomic writes |
| `tools/terminal.ts` | `runCommand` (bash, own process group, SIGTERM→SIGKILL, output caps, stdin EOF), `ProcessManager` (background processes), `TerminalTool`, `ProcessTool` |
| `tools/git.ts` | status/diff/log/branch/checkout/add/commit/stash/init/worktree/merge(abort on conflict)/clone — argument arrays, no shell |
| `tools/http.ts` | fetch with timeout, body cap, scheme/metadata-host/allowlist policy, header redaction |
| `verification.ts` | Runs verification specs (unit/integration/e2e/lint/typecheck/build/custom) → `VerificationResult` with artifacts; declarative acceptance checks |
| `queue.ts` | Pure priority + dependency queue: ready set, cycle detection, dead-dependency (BLOCKED) detection |
| `agents.ts` | `BudgetGuard`, `runAgent` lifecycle events, Planner (spec → DSL → model), Researcher, Executor (expectations, inline retry), Tester, Reviewer (7 check categories), Debugger (classification + fix steps), Integrator (worktree commit+merge+rollback) |
| `orchestrator.ts` | The per-task state machine, checkpointing, self-correction loop, retry policy, FAILURE_ANALYSIS.md |
| `runtime.ts` | Façade: create/start/run/pause/resume/cancel/retry/recover, scheduler, control channel, daemon, doctor |
| `metrics.ts` | O(1) counters/timings fed by the bus; JSON + Prometheus text |
| `model.ts` | `ModelProvider` interface, OpenAI-compatible client (text `complete`, native tool-calling `completeWithTools`, SSE `stream`), env factory, JSON extraction |
| `config.ts` | `.agentos/config.json` schema + validation: lifecycle hooks and MCP servers |
| `hooks.ts` | `HookRunner`: runs `pre_tool_call` / `post_tool_call` / `task_completed` / `task_failed` hooks (Claude Code semantics: exit 2 blocks); payload via stdin, redacted |
| `mcp.ts` | Minimal MCP stdio client (JSON-RPC over newline-delimited stdio): initialize → tools/list → tools/call; registers each MCP tool as a registry tool `mcp_<server>_<tool>` |
| `chat.ts` | Interactive REPL (`agentos chat`): goals → agentic tasks with live streamed output, permission prompts, Ctrl-C cancels the running task; `chatTurn()` is the testable core |
| `sandbox.ts` | Pluggable sandbox tiers for shell commands: `none` / `process` (POSIX ulimit caps) / `container` (ephemeral Docker: workspace at `/workspace`, no network, dropped caps, mem/cpu/pids limits); script-file mounting keeps stdin usable; fails closed or degrades per config |
| `secrets.ts` | Encrypted local vault (`.agentos/secrets.json`, AES-256-GCM; master key in `.agentos/secret.key` 0600 or `AGENTOS_SECRET_KEY`); CLI `agentos secrets`; names only in diagnostics |
| `providers.ts` | Provider profiles (openai / github-models / deepseek / glm / ollama / custom reverse proxy): baseUrl, model, key env names, compatibility quirks (tool-call streaming, JSON mode, maxTokens); key resolution config.llm.apiKeySecret → env → vault |
| `cli.ts` | Command line interface |
| `server.ts` | Next.js server singleton (PG persistence, auto-recover, daemon) |

## Task lifecycle

```
CREATED → QUEUED → PLANNING → EXECUTING → VERIFYING → REVIEWING → COMPLETED
                                  │            │           │
                                  └──── FIXING ◄───────────┘        (self-correction, ≤ maxRetries fix attempts)
                                          │  Debugger → fix steps → back to EXECUTING/VERIFYING
                                          ▼
      any unrecoverable error ──► DIAGNOSING ──► RETRYING (attempt++ , fresh plan)  or  FAILED (+ FAILURE_ANALYSIS.md)
      pause/cancel (AbortSignal reason) ──► PAUSED (checkpoint kept) / CANCELLED
      dependency failed ──► BLOCKED
```

Budgets: `maxRetries` (task attempts *and* fix attempts), `timeoutMs` (wall clock across resumes), `maxToolCalls`, `maxTokens`.
Budget violations are terminal (never retried).

### Execution modes

- **plan** (default): the planner produces a static step plan (spec → goal DSL → model) and the executor runs it
  deterministically with retries.
- **agentic** (`spec.mode: "agentic"`, requires an LLM with native tool calling): the model drives the tool registry in a
  loop — it proposes one or more tool calls per turn, each call is executed through the same registry (budgets, hooks,
  permission gate, checkpoints) and the structured result is fed back, until the model answers without tool calls. The
  conversation is trimmed to whole tool-call turns so provider pairing rules stay intact; `PLANNING` emits an empty marker
  plan and the transcript lands in `completedSteps`, so verification, reviewer, debugger and recovery behave exactly as in
  plan mode. Model text streams out as transient `model.delta` events; `AGENTS.md` instructions are injected; conversations
  past 100 messages are compacted (LLM summary of dropped turns).

### Permissions

`AgentRuntime` accepts `permissionMode: "confirm"` + `onPermissionRequest`. In confirm mode `ToolRegistry.execute` asks
the callback before every execution; a refusal (or a failed prompt) yields `PERMISSION_DENIED`, a fatal step error.
`auto` mode (default, batch/CI) never prompts. Hooks run after the human decision, so a `pre_tool_call` hook can still
block what the user allowed.

## Checkpoint / recovery

A `Checkpoint` (phase, attempt, plan, completed step results, messages, verification, review, diagnosis, usage, git state,
worktree) is persisted **after every step and every phase transition**, plus a heartbeat. On restart, `recoverAll()` finds tasks
whose persisted status is active/queued, verifies the environment (workdir exists, worktree exists, git HEAD compared) and
re-enqueues them; the orchestrator resumes at the checkpoint phase, skipping steps whose results are already recorded.
Cross-process pause/cancel uses `.agentos/control/<taskId>.json`.

## Parallelism / isolation

The scheduler runs up to `concurrency` tasks at once (independent tasks in parallel, dependent ones in order). Tasks with
`isolated: true` execute in a dedicated `git worktree` on branch `agentos/<taskId>`; on reviewer PASS the Integrator commits
and merges (`--no-ff`) into the base branch, aborting and rolling back on conflict (task FAILED with `MERGE_CONFLICT`, the
branch is kept for inspection).

## Events

`task.created|queued|started|resumed|planned|executing|verifying|fixing|reviewing|diagnosing|retrying|paused|cancelled|blocked|completed|failed|recovering|control`,
`agent.started|completed|failed|tool_call|retry`, `tool.started|completed|failed`, `test.started|passed|failed`,
`review.check_passed|check_failed|git_state|completed`, `task.diagnosed`, `checkpoint.saved`, `workspace.isolated`,
`integrator.committed|merged|conflict`, `model.completed`, `model.delta` (transient, never persisted),
`model.context_compacted`, `hook.executed`, `mcp.registered|failed`, `acceptance.passed|failed`.
Every event carries `ts, seq, taskId, agentId, type, tool, args, result, durationMs, error, data` (args/result/data redacted).
Transient events fan out to live subscribers only — stores, JSONL mirror and replay stay clean.

## Extensions (`.agentos/config.json`)

- **hooks** — `pre_tool_call` (exit 2 blocks the call with `HOOK_BLOCKED`; stderr becomes the reason), `post_tool_call`,
  `task_completed`, `task_failed`. Payload on stdin, event metadata in `AGENTOS_*` env vars, all redacted; `hook.executed`
  events record every run. Wired into `ToolRegistry.execute` and the runtime's terminal-state handler.
- **mcpServers** — connected at runtime start (stdio JSON-RPC); failures emit `mcp.failed` and are non-fatal. MCP tools
  participate in plans, DSL, agentic mode, budgets and checkpoints like built-in tools.
