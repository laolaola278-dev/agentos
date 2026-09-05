# PROGRESS

## Round 1
- Recon done. Node 22.22, Next 16.2, Drizzle 0.45, PG. No git repo → initialised, baseline commit.
- Installed tsx. Verified node:sqlite works.
- Created state files.
- Next: core runtime implementation.

## Round 2 — core runtime + tests
- Implemented all core modules under src/agentos (≈3.5k lines) and CLI.
- Tests: 58 test cases across unit/integration/e2e/recovery/stress/chaos — all green.
- Bugs found & fixed by tests: duplicate task.completed event; DSL parser silently ignoring malformed lines;
  `.agentos/` polluting git status in workspaces (now registered in .git/info/exclude); recovery test killed
  tsx wrapper instead of worker (harness fix); e2e CLI needed an absolute tsx loader → added bin/agentos.js.
- Stress: 200 tasks / 1.7s at concurrency 16 (118 tasks/s); 5000 events: sqlite 15k ev/s, file/JSONL 3.7k ev/s;
  100 concurrent tool calls in 124ms; heap growth +12MB over 200 tasks; zero leaked checkpoints/processes.
- Next: PG persistence + dashboard.

## Round 3 — PG persistence, dashboard, docs, benchmark, audit
- Drizzle schema + PgPersistence; Next API routes (tasks, actions, events, SSE stream, metrics, agents, tools, doctor); dashboard + task detail pages.
- Verified against real PostgreSQL: API-created task COMPLETED/PASS, 31 events persisted, SSE streamed, Prometheus exported.
- CLI gained `--store pg`; bin/agentos.js launcher; benchmark script with measured results → BENCHMARK.md.
- Docs written; audit: no TODO/FIXME/stub/placeholder; full suite 58/58; lint + typecheck clean; next build OK.

## Round 4 — harness upgrade (Claude Code / Codex / ZCode alignment)
- Baseline audit found 2 stale unit tests (validatePlan read-args, extractJson message) — repo had also lost its `.git`
  and `.env.example` when re-extracted from the zip; both restored, baseline committed before changes.
- Model layer: `completeWithTools` (OpenAI-compatible function calling) and SSE `stream()`; one shared
  timeout/abort/retry/redaction pipeline; tool messages mapped natively (text endpoints get flattened turns).
- Agentic mode: `AgenticLoopAgent` + `spec.mode: "agentic"`; model proposes tool calls per turn, results fed back,
  per-call checkpoints, budgets terminal, conversation trimmed in whole tool-pairs; verification + reviewer unchanged.
- Hooks: `config.ts` (validated `.agentos/config.json`) + `HookRunner`; `pre_tool_call` exit 2 → `HOOK_BLOCKED`
  (added to fatal codes), post/task hooks non-blocking; wired into `ToolRegistry.execute` and runtime terminal states;
  `hook.executed` events; payload redacted; child env rebuilt via `buildSafeEnv` (PATH must survive!).
- MCP: stdio JSON-RPC client (`initialize`/`tools/list`/`tools/call`, cursor pagination, request timeouts), one registry
  tool per MCP tool (`mcp_<server>_<tool>.call`), down server → `mcp.failed` + runtime stays usable; `close()` awaits
  child exit so Windows tmp cleanup is reliable.
- DB: lazy drizzle client — `next build` no longer requires DATABASE_URL; `.env.example` restored.
- Tests: +25 (mocked-provider agentic scenarios incl. unknown-tool recovery + budget exhaustion, hooks block/advise/post,
  MCP end-to-end with a test stdio server, config validation, SSE wire format). 83/83, lint + typecheck + build clean.
- CLI smoke test on real FS: DSL task COMPLETED/review PASS, config.json hook auto-loaded and executed.
