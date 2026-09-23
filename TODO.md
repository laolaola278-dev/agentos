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
[x] Phase 11 Hardening round (sandbox, secrets vault, provider profiles)
    [x] Task 11.1 sandbox.ts: none/process/container tiers; container = ephemeral Docker (no network, dropped caps,
        mem/cpu/pids caps, workspace at /workspace, stdin preserved via mounted run-script); fails closed by default
    [x] Task 11.2 secrets.ts: AES-256-GCM vault + `agentos secrets` CLI + key resolution (named vault entry → env → default)
    [x] Task 11.3 providers.ts: provider profiles incl. GitHub Models gateway, DeepSeek, GLM, Ollama, custom reverse
        proxies; quirk adaptation (tool-call streaming on/off) + malformed tool-argument repair + model.truncated events
    [x] Task 11.4 doctor reports provider profile, sandbox tier, vault entries (names only)
    [x] Task 11.5 Tests: 126 total (container tier gated on a reachable Docker daemon)
[x] Phase 12 Capability-uplift round (E1/E3/E5 + auth hardening + baseline fixes)
    [x] Task 12.1 Baseline: orchestrator save() tolerates transient checkpoint failures (absorb + `checkpoint.save_failed`
        warning; task-record failure still fails the task — chaos contract kept); recovery control test polls for step "b"
        instead of a fixed 500ms sleep
    [x] Task 12.2 maxTokensField quirk (mirrors the dsh finding): per-provider body field max_tokens ↔
        max_completion_tokens; a 400 naming the parameter auto-flips and retries once, retry budget untouched
    [x] Task 12.3 E1 context.ts: cleanToolResult (head+tail strings, sliced arrays, stripped noisy keys) applied to
        model-facing tool results; NotesStore external memory per task (survives compaction); contextBudgetReport
    [x] Task 12.4 E5 skills.ts: .agentos/skills/*.md loader + injection-pattern scan (reject with reason) + capped
        system-prompt section + agentos skills list|show; runtime loads at start, skills.rejected audit event
    [x] Task 12.5 Scoped API keys auth.ts: SHA-256 hashed storage (plaintext once), tasks:read/write/admin scopes,
        per-key token bucket, audit events, enforcement in dashboard API routes (off until first key), agentos apikeys CLI
    [x] Task 12.6 E3 evals.ts: suite format + deterministic scorer + persisted reports + mechanical variant comparison
        + agentos eval run|compare CLI
    [x] Task 12.7 Docs synced (README/ARCHITECTURE/SECURITY/DEVELOPMENT/STATE/PROGRESS)
[x] Phase 13 CLI-gap upgrade (each item implemented → tested → compared against the corresponding CLI's docs)
    [x] Task 13.1 Parallel tool calls: a turn's independent calls execute with bounded concurrency (default 4,
        agentic.parallelToolCalls/maxParallel config); results re-ordered to model order preserving pairing
    [x] Task 13.2 Subagent tool: isolated child runtime (fresh conversation/memory, registry without subagent — no
        recursion), parent sees capped {status, summary} only; optional per-subagent instructions; subagent:false disables
    [x] Task 13.3 repo-map (Aider-style, heuristic v1): TS/JS/Python/Go/Rust symbol extraction, dependency-dir skip,
        symbol-density ranking, char budget; injected into agentic prompts + researcher reports
    [x] Task 13.4 Permission policy table (Claude Code permissions semantics): config permissions.allow/deny patterns,
        deny wins, explicit allow skips confirm prompts, bare-tool deny hides the schema from the model; /allow in chat
    [x] Task 13.5 Sandbox hardening: CPU-seconds cap (ulimit -t) + injectable platform + container read-only rootfs
        (Codex read-only-mode parity); Windows process tier remains an honest degrade
    [x] Task 13.6 Chat session persistence + resume (chat-session.json, context seeded into first resumed turn) and a
        slash-command registry (extensible via extraCommands; /help lists registered commands; /history, /new added)
    [x] Task 13.7 Built-in eval preset: `core` suite (6 deterministic offline cases) via `agentos eval run --preset core`
    [x] Task 13.8 MCP Streamable HTTP transport: JSON-RPC over POST, JSON + SSE response parsing, Mcp-Session-Id
        carry-forward, custom headers; config mcpServers.<name>.transport=http + url/headers
[x] Phase 14 Remaining-deficiency closure (all four audit leftovers)
    [x] Task 14.1 Subagent tool allowlists: `tools` arg filters the child registry to allow-listed tools/actions
        (ToolRegistry.filteredView); agentic children see only the allowed schemas, disallowed steps fail UNKNOWN_TOOL
    [x] Task 14.2 Permission `ask` tier: precedence deny > ask > allow; ask forces the approval prompt even in auto
        mode and fails closed without an approval channel (headless)
    [x] Task 14.3 Transcript-level chat session resume: TaskSpec.context (≤20 user/assistant messages) seeded into the
        agentic conversation; chat-session entries store the model's closing message; turns replay as real messages
    [x] Task 14.4 MCP advanced session handling: 404 session-expiry → transparent re-initialize + request replay;
        close() sends the spec DELETE termination; runtime.close() awaits MCP client shutdown
[x] Phase 16 Web-UI completion
    [x] Task 16.1 Web approval bridge (server.ts): confirm-gate parks in queue; timeouts deny; audited events
    [x] Task 16.2 /api/agentos/approvals (list + decide); ApprovalToaster in the dashboard (approve/deny, fail-closed copy)
    [x] Task 16.3 /chat conversational page (SSE live deltas/tools, transcript resume, task links) + /api/agentos/chat
    [x] Task 16.4 SSE stream persists finished agentic turns into the chat session
    [x] Task 16.5 Integration test for the bridge (approve/deny/timeout); live verification of pages + APIs
[x] Phase 17 Safe parallel tool calls
    [x] Task 17.1 ToolActionDef.readOnly on filesystem/git/http/process read actions
    [x] Task 17.2 partitionToolCalls + mapLimited: mutating calls are a wave of one; read-only waves honour maxParallel
    [x] Task 17.3 Integration test: two writes never overlap, two reads do, model order preserved
    [x] Task 17.4 Stress re-run: 200 tasks at concurrency 16, 100 concurrent tool calls, 5000 events x2 stores
[x] Phase 18 Gap closure (search, repo-map, token compaction, subagent roles, Windows sandbox)
    [x] Task 18.1 globToRegExp single-pass; `**` matches nested paths; CR stripped from search hits
    [x] Task 18.2 repo-map: Java/Kotlin/C/C++/Ruby, declaration-less files kept, extensions option works
    [x] Task 18.3 compactConversation drops leading turns once the estimated token budget is exceeded
    [x] Task 18.4 subagent roles explore/implement/review with default tool allowlists
    [x] Task 18.5 process sandbox fails closed on win32 unless onUnavailable=degrade; docs synced
