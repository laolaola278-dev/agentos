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

## Round 8 — capability-uplift round (continued from the parallel session's task list)
Picked up the 6-item list the parallel session left mid-flight and closed it, after re-verifying the baseline myself
(127 tests / 125 pass / 1 fail / 1 skip):
- **#1 baseline** — the failing new fault-injection test (step-idempotency) exposed a real product gap: a transient
  `saveCheckpoint` failure killed the task. Fixed in `orchestrator.save()`: a lost checkpoint is absorbed with a
  `checkpoint.save_failed` warning as long as the task record still persists; `saveTask` failure (store truly down)
  still fails the task — both the idempotency test and the chaos contract pass. The recovery control-channel test now
  polls for step "b"'s side effect instead of a fixed 500ms sleep (their timing diagnosis, applied).
- **maxTokensField quirk** — finished the fix motivated by the dsh finding (pi-ai guessed max_completion_tokens for an
  unknown provider while z-ai models only accept max_tokens): the body field is per-profile/config (`llm.maxTokensField`)
  and any 400 naming the parameter auto-flips max_tokens ↔ max_completion_tokens and retries once without consuming
  the retry budget.
- **E1 context.ts** — tool results are cleaned (head+tail strings, sliced arrays, stripped noisy keys) before entering
  the model conversation; per-task external notes (`notes.md`) survive conversation compaction and are seeded into the
  agentic conversation; `contextBudgetReport` makes the budget visible.
- **E5 skills.ts** — `.agentos/skills/*.md` with frontmatter; hostile skills (RCE pipes, instruction overrides, persona
  hijacks, prompt extraction, secret-shaped tokens, special-token smuggling) are REJECTED with a reason and never reach
  the model; clean skills inject a capped section into the agentic system prompt; `agentos skills list|show`.
- **Scoped API keys (auth.ts)** — plaintext shown once, SHA-256 hashed at rest, tasks:read/write/admin scopes, per-key
  token bucket, audit events (`apikey.*`), enforcement wired into the dashboard task routes (off until the first key
  exists). Fixed an auth bug during review: a required `admin` scope previously passed for ANY valid key.
- **E3 evals.ts** — suite format, deterministic scorer, persisted reports, mechanical compare (regressions named);
  `agentos eval run|compare`. CLI smoke: suite of 2 → 1/2 passed with the failing case named; apikeys/skills verified.
- Tests: +15 (unit + integration); full suite run after this round reported in STATE.md.

## Round 9 — CLI-gap upgrade (implement → test → compare against the corresponding CLI, per item)
Closed the actionable gaps from the detailed CLI comparison, each with a post-implementation comparison pass:
1. **Parallel tool calls** (vs Claude Code/OpenAI parallel function calling): bounded concurrency (4), model-order
   result pairing; added `agentic.parallelToolCalls/maxParallel` after the comparison flagged the missing
   disable_parallel_tool_use knob. [Anthropic parallel-tool-use docs]
2. **Subagent tool** (vs Claude Code Task/subagents): isolated child runtime — fresh conversation, memory persistence,
   registry WITHOUT subagent (no recursion) — parent sees capped {status, summary} only; `instructions` arg added after
   comparison flagged the missing custom-subagent persona. [Claude Code sub-agents docs]
3. **repo-map** (vs Aider tree-sitter): heuristic v1 symbol extraction (TS/JS/Py/Go/Rust), budget-bounded, injected into
   agentic prompts + researcher; regex limitation documented. [Aider repo-map analyses]
4. **Permission policy table** (vs Claude Code permissions): config allow/deny patterns, deny wins, explicit allow
   skips prompts, bare-tool deny hides schemas from the model (comparison flagged the difference); chat /allow.
   [Claude Code permissions docs]
5. **Sandbox hardening** (vs Codex Landlock/seccomp/bwrap): CPU-seconds cap, injectable platform, container read-only
   rootfs. Kernel-level FS/syscall isolation on par with Codex remains out of reach without native bindings — documented
   limitation; container tier is the strong-isolation path. [Codex sandbox analysis]
6. **Chat session persistence + resume + slash registry** (vs Claude Code --resume / slash commands): session file with
   turn summaries seeded into the first resumed turn; extensible slash registry (/help lists them); /history, /new.
   Transcript-level resume deliberately lighter (token budget). [Claude Code commands docs]
7. **Built-in eval preset** (vs Terminal-Bench task structure): `core` suite, 6 deterministic offline cases, all green
   twice in a row (determinism check).
8. **MCP Streamable HTTP transport** (vs MCP spec 2025-03-26+): POST JSON-RPC, JSON+SSE response parsing,
   Mcp-Session-Id carry-forward, custom headers, graceful mcp.failed on misconfig. Spec gaps left open: 404 session
   re-initialize, GET server-initiated stream, DELETE termination. [MCP transport spec]

## Round 10 — remaining-deficiency closure (subagent allowlists, ask tier, transcript resume, MCP sessions)
All four leftovers from the CLI-gap report closed, each with tests:
- **Subagent tool allowlists** (Claude Code subagent `tools:`): `subagent__run.tools` filters the child registry via
  `ToolRegistry.filteredView` — agentic children see only allowed schemas; plan-mode children fail UNKNOWN_TOOL on
  anything outside the allowlist.
- **Permission ask tier**: policy precedence is now deny > ask > allow; an ask rule forces the approval prompt even in
  auto mode and fails closed (PERMISSION_DENIED) when no approval channel exists — headless-safe.
- **Transcript-level session resume**: `TaskSpec.context` (≤20 user/assistant messages, validated) is seeded into the
  agentic conversation as real messages; chat-session entries persist the model's closing message; `chat --resume`
  replays prior turns as a transcript instead of a summary block, and turns accumulate across the live session too.
- **MCP advanced sessions**: an expired session (spec: 404) triggers a transparent re-initialize + one request replay;
  `close()` sends the spec DELETE termination; `runtime.close()` now awaits MCP client shutdown (caught a fire-and-
  forget close that truncated the DELETE).

## Round 11 — web UI completion (chat page + tool-approval gate)
- **Web approval gate**: the server runtime's permission gate now bridges to the web — confirm-mode tool
  calls park in an in-process queue (`/api/agentos/approvals` GET/POST), the dashboard renders an
  approve/deny toast (ApprovalToaster), timeout denies fail-closed (5 min), every decision is audited via
  `approval.requested|granted|denied` events. Integration test covers approve/deny/timeout paths.
- **Chat page** (`/chat`): DeepSeek-harness-style conversational frontend — each message starts an agentic
  task (transcript-seeded from the persisted session), SSE renders model deltas + tool activity live,
  assistant bubbles link to task detail; prior turns replay from chat-session.json; accurate no-LLM banner.
- **Chat API**: `/api/agentos/chat` GET (session) / POST (start turn) / PUT (persist); SSE stream persists
  finished agentic turns into the chat session automatically.
- Verified live: dashboard Chat entry, /chat page load, noModel 503 banner, approvals API (empty list /
  404 bogus id); build green; full-suite results in STATE.md.

## Round 12 — safe parallel tool calls (Claude Code isConcurrencySafe)
- Stress baseline (before the change): 40 tasks / concurrency 16 in 4.2s; 100 tool calls; 5000 events
  through sqlite and file stores. All four stress tests green. The suite does not exercise one model
  turn issuing several writes, so it could not see the race below.
- Defect: `AgenticLoopAgent` ran every tool call of a turn concurrently up to `maxParallel`. A turn
  that writes two files (or writes while a shell runs) overlapped those calls. Claude Code only
  parallelises tools flagged `isConcurrencySafe`; Codex keeps mutations on one lane.
- Change: `ToolActionDef.readOnly` on filesystem read/list/search/stat/exists, git status/diff/log/
  rev_parse/state, http get, process list/output. `partitionToolCalls` makes each mutating call its
  own wave; a run of read-only calls shares a wave capped by `maxParallel` (default 4, hard max 16).
  `mapLimited` is the pool. Results stay in model order. `ToolRegistry.aroundExecute` lets tests
  observe overlap without replacing tools.
- Proof: integration test holds filesystem calls for 120ms and records peak overlap — writes peak at
  1, reads peak at 2, step order is w1, w2, r1, r2. Agentic suite 13/13.
- Stress after the change (`STRESS_TASKS=200`, concurrency 16): 200 tasks in 18.9s (10.6 tasks/s),
  6000 events, heap +13.2MB, no leaked checkpoints or processes. 100 concurrent tool calls in 2.3s.
  5000 events: sqlite 788 ev/s, file 934 ev/s, replay order preserved. 4/4 green.

## Round 13 — gap closure against Claude Code / Codex / Aider
Scoped to what this repo can actually ship. Not in scope: an IDE, voice/image input, a plugin
marketplace, or a native Anthropic protocol.
- **Search.** `globToRegExp` compiled `**` by string replace, then rewrote the `*` inside the
  replacement, so `**/*.txt` matched nothing. It is now a single left-to-right scan. `**/` matches
  zero directories. Search splits on CR as well as LF, so CRLF hit text no longer ends in `\r`.
- **Repo map.** Java/Kotlin, C/C++ and Ruby patterns added. A source file with no recognised
  declaration stays on the map as `(no declarations)`. `RepoMapOptions.extensions` is actually read;
  unknown extensions fall back to the JS/TS patterns instead of disappearing.
- **Compaction.** `compactConversation` now also triggers when the estimated token count (4 chars per
  token, default 24k) is exceeded, and drops whole leading turns until the tail fits. The 100-message
  path is unchanged.
- **Subagent roles.** `subagent.run` accepts `role: explore | implement | review`. Each role adds
  instructions and a default tool allowlist; an explicit `tools` argument still wins. `explore`
  cannot write.
- **Windows sandbox.** `mode=process` on win32 used to run the command unsandboxed and only set a
  note. It now throws `SANDBOX_UNAVAILABLE` unless `onUnavailable: "degrade"` is set. README (en,
  zh-CN, ja), SECURITY and ARCHITECTURE match the code.
- Proof: tools + repomap + extensions + sandbox unit tests, agentic integration and the sandbox
  integration file — 51 passed, 1 skipped (container tier, Docker daemon not reachable). `tsc --noEmit` clean.
