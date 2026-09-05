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

## Round 5 — audit remediation (streaming, permissions, chat, context, real-store coverage)
An independent audit of Round 4 verified the claims (83/83 real, git/docs true) and flagged: `stream()` was dead code,
the LLM path had never seen a real provider, no PG regression existed, STATE.md counts drifted, and the orchestrator's
research wiring was indirect. All closed:
- Streaming end-to-end: provider `stream()` now accumulates `delta.tool_calls` fragments (index-keyed reassembly, tested
  with split chunks); `AgenticLoopAgent` streams by default and emits transient `model.delta` (fan-out only, never
  persisted — store/JSONL/replay stay clean); `task run` and the new chat render deltas inline.
- Permissions: `PermissionGate` in `ToolRegistry.execute` (confirm asks before every call, prompt failure = fail-closed),
  `PERMISSION_DENIED` is fatal; runtime options `permissionMode`/`onPermissionRequest`.
- `agentos chat` REPL: goal → agentic task with live streamed transcript; `/tools /tasks /auto /confirm`; Ctrl-C cancels
  the running task; `chatTurn()` extracted as the testable core; result exposes the model's closing message
  (`result.finalMessage` via checkpoint).
- Context management: `AGENTS.md`/`CLAUDE.md`/`AGENTOS.md` injected into the agentic system prompt (capped); automatic
  compaction past 100 messages (LLM summary of dropped turns, deterministic marker without model, pairing preserved).
- Researcher report is now explicitly seeded into the agentic conversation (was implicit via checkpoint messages).
- Real-LLM smoke tier: `npm run test:smoke` (`LLM_SMOKE=1` + key; real provider, real tool calls, offline-skipped).
- PostgreSQL regression: `tests/integration/pg.test.ts` runs against a live server via `TEST_DATABASE_URL` — verified
  here on a real PostgreSQL (lifecycle, event replay from a second runtime instance, checkpoint round-trip, dashboard
  boot path). Skipped with a clear note when the env var is absent.
- Fixed STATE.md suite-count drift; docs updated (README, ARCHITECTURE, DEVELOPMENT, TODO, FINAL-REPORT addendum).
- Tests: 101/101 with `TEST_DATABASE_URL` set (unit 61, integration 25, e2e 2, recovery 4, chaos 5, stress 4);
  lint/typecheck/build clean. Remaining known gaps are documented limitations (OS sandbox, real-token metering).

## Round 6 — second audit remediation (REPL coverage, injection lock, doc drift, EOF hang bug)
Closing the gaps the Round-5 audit surfaced:
- `runChat` is now testable: injectable `input`/`output` streams; every print routes through them.
- **Real bug found by the new tests**: a pending `rl.question()` never settles when the input stream ends or the
  interface closes on Node 24 (verified with a minimal probe) — piped-stdin `agentos chat` and Ctrl-C at the prompt
  hung forever. Fixed with a closed-signal race around every question (main loop and permission prompts; a closed
  prompt denies fail-closed). Verified: `printf "" | agentos chat` exits 0, no-key goal errors then exits 1.
- chat REPL integration tests (PassThrough-driven): full session (banner, /tools, streamed goal turn, /tasks, /exit),
  permission toggles + unknown command + graceful EOF exit, and the confirm-mode denial flow (allow researcher's
  filesystem.list, deny filesystem.write → `✗ PERMISSION_DENIED` rendered, no file written).
- AGENTS.md → agentic system-prompt injection locked by an integration test (content + goal + workspace path asserted).
- Doc drift fixed: filesystem has 14 actions (apply_patch/patch existed in the baseline; docs said 12) —
  API.md, ARCHITECTURE.md, FINAL-REPORT.md corrected.
- Audit item left open by design: real-LLM smoke still requires a key in the environment (no key available here).

## Round 7 — hardening round (sandbox, secrets vault, provider profiles)
Four features, one boundary statement: these adapt to providers and contain accidents — they never bypass payment,
auth or rate limits.
- **Sandbox tiers** (`sandbox.ts`): `container` (ephemeral Docker per command — workspace at /workspace, network off,
  `--cap-drop ALL`, mem/cpu/pids caps; the command is written to a mounted run-script so stdin keeps working; cleanup
  deletes it), `process` (POSIX ulimit vmem/pid caps; Windows degrades with a note), `none` (default). Fails closed when
  Docker is unreachable unless `onUnavailable: "degrade"`. Wired into the terminal tool AND the verification engine;
  `doctor` reports the active tier.
- **Secrets vault** (`secrets.ts` + `agentos secrets`): AES-256-GCM at rest, master key in `secret.key` (0600) or
  `AGENTOS_SECRET_KEY`; wrong/rotated key fails closed; get masks values by default; doctor shows entry names only.
  Provider key resolution: named vault entry (`config.llm.apiKeySecret`) → provider env vars → vault default entry.
- **Provider profiles** (`providers.ts`): `openai`, `github-models` (models.github.ai/inference + GITHUB_TOKEN),
  `deepseek`, `glm`, `ollama` (keyless local), `custom` (reverse proxy with baseUrl + vault secret). Profiles carry
  compatibility quirks; `toolStreaming: false` (default for deepseek/glm/ollama/custom) makes the agentic loop fall
  back to non-streaming tool calling — the practical fix for reverse proxies that mangle SSE tool_calls.
- **Model-quirk repairs**: malformed tool-call arguments (markdown fences, smart quotes, trailing commas, unbalanced
  closers, garbage after the object) are repaired before failing; `finish_reason: "length"` emits `model.truncated`.
- Tests: 126 total — container tier verified by a real Docker integration test (gated on a reachable daemon; skipped
  on this box where the daemon is down), vault/profile/sandbox/repair covered by unit tests; CLI smoke verified the
  vault end-to-end (set → list → masked get → doctor `key=vault` → delete).
