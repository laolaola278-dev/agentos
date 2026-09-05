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
