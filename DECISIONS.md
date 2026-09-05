# DECISIONS

## D1 — Keep the existing Next.js + Drizzle + PostgreSQL stack; add a framework-free core
The repo is a Next 16 / Drizzle / PG template. AgentOS core (`src/agentos/`) is plain TypeScript with
zero framework dependencies so it runs in the CLI, in tests and inside the Next server process.
PostgreSQL is used by the dashboard; SQLite (`node:sqlite`, built into Node 22) and JSONL are used
for local/offline runs and tests. Reason: the spec asks for JSONL + SQLite; the platform provides PG.

## D2 — Test runner: `node:test` + `tsx`
No new test framework. `tsx` honours tsconfig `paths`, so `@/` imports work. Fewer moving parts.

## D3 — Model provider is pluggable, default is deterministic
An `OpenAICompatibleProvider` is used when `LLM_API_KEY`/`OPENAI_API_KEY` is set. Without a key the
Planner uses a deterministic goal-DSL parser (`write path: content`, `run: cmd`, `verify: cmd`, ...).
This keeps the harness testable, reproducible and honest — no fake LLM output.

## D4 — Checkpoints are written atomically (tmp + rename) after every step and phase change
Recovery resumes from the last completed step. Steps are recorded with their results so completed
steps are never re-executed after a crash.

## D5 — Cross-process control via a file-based control channel
`pause`/`cancel` from another CLI process writes `.agentos/control/<taskId>.json`; the running
runtime polls it. Simple, durable, no daemon socket required.

## D6 — Terminal commands run in their own process group
So timeouts/cancellation kill the whole tree (SIGTERM → SIGKILL) and a runaway child can never hang
the runtime.
