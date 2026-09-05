# TODO — AgentOS

[x] Phase 1 Recon & state system
    [x] Task 1.1 Inspect repo (Next 16, Drizzle, PG, Node 22, no git → git init done)
    [x] Task 1.2 Create STATE/TODO/DECISIONS/PROGRESS/ARCHITECTURE
    [x] Task 1.3 Test runner: node:test + tsx
[x] Phase 2 Core runtime
    [x] Task 2.1 types.ts
    [x] Task 2.2 security (redaction, path guard, env allowlist, command boundary)
    [x] Task 2.3 persistence (memory, file/JSONL, sqlite, pg)
    [x] Task 2.4 event bus (emit/subscribe/stream/replay)
    [x] Task 2.5 tool runtime (registry, fs, terminal, git, http, process)
    [x] Task 2.6 verification engine
    [x] Task 2.7 task queue (priority, deps, cycles)
    [x] Task 2.8 agents (planner, executor, tester, reviewer, debugger, researcher, integrator)
    [x] Task 2.9 orchestrator (lifecycle, budgets, self-correction, checkpoints)
    [x] Task 2.10 runtime facade (create/start/pause/resume/cancel/retry/recover, daemon, control channel)
    [x] Task 2.11 metrics (json + prometheus)
    [x] Task 2.12 parallel workspaces (git worktree) + integrator
[x] Phase 3 CLI
[x] Phase 4 Web dashboard (Next.js + PG persistence, SSE)
[x] Phase 5 Tests: unit / integration / e2e / recovery / stress / chaos (all passing)
[x] Phase 6 Docs + benchmark + security review
[x] Phase 7 Final audit + FINAL-REPORT.md
[x] Phase 8 Harness upgrade (Claude Code / Codex / ZCode alignment)
    [x] Task 8.1 Fix stale unit tests (error-message drift after validateActionArgs/extractJson changes)
    [x] Task 8.2 Model layer: native tool-calling (completeWithTools) + SSE streaming, shared retry pipeline
    [x] Task 8.3 Agentic mode: LLM drives the tool registry, budgets/checkpoints/verification/review intact
    [x] Task 8.4 Hooks: pre_tool_call (exit 2 blocks), post_tool_call, task_completed, task_failed via .agentos/config.json
    [x] Task 8.5 MCP: stdio client, tools registered at runtime start, down-server resilience
    [x] Task 8.6 Lazy PostgreSQL client (next build works without DATABASE_URL) + restored .env.example
    [x] Task 8.7 Mocked-provider tests: planner-free agentic scenarios, hooks, MCP server, SSE wire format (83 tests total)
[x] Phase 9 Audit remediation (independent audit found dead streaming path, doc drift, missing real-store coverage)
    [x] Task 9.1 stream() wired end-to-end: tool-call fragment reassembly in the provider, agentic loop streams,
        transient model.delta events (never persisted), task run + chat render deltas inline
    [x] Task 9.2 Permission gate: confirm/auto modes, PERMISSION_DENIED fatal code, runtime options, chat wiring
    [x] Task 9.3 `agentos chat` interactive REPL (streamed output, /tools /tasks /auto /confirm, Ctrl-C cancels task)
    [x] Task 9.4 Context management: AGENTS.md/CLAUDE.md/AGENTOS.md instructions injected; compaction past 100 messages
    [x] Task 9.5 Real-LLM smoke tier (test:smoke, skipped without LLM_SMOKE=1) + researcher report seeded into agentic conversation
    [x] Task 9.6 PostgreSQL regression suite against a live server (TEST_DATABASE_URL; dashboard boot path, checkpoint round-trip)
    [x] Task 9.7 Fixed STATE.md suite-count drift (83 total but wrong distribution)
[x] Phase 10 Second audit remediation (REPL testability, injection lock, doc drift, EOF hang)
    [x] Task 10.1 runChat accepts injected input/output streams; all prints routed through them
    [x] Task 10.2 Fixed real bug found while testing: pending rl.question never settles on EOF/Ctrl-C at the
        prompt (hangs piped stdin) → closed-signal race for main loop and permission prompts (fail-closed denial)
    [x] Task 10.3 chat REPL integration tests via PassThrough: full session (banner//tools//tasks/goal streaming/exit),
        toggles + unknown command + EOF exit, confirm-mode denial (y then n)
    [x] Task 10.4 AGENTS.md → agentic system prompt injection locked by an integration test
    [x] Task 10.5 Doc drift: filesystem is 14 actions (apply_patch/patch existed since baseline) — API.md/ARCHITECTURE/FINAL-REPORT corrected
