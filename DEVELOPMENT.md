# DEVELOPMENT

## Layout
- `src/agentos/` core (no framework imports; runs under tsx, tests and Next).
- `src/agentos/persistence-pg.ts`, `src/agentos/server.ts` PG + Next-only pieces.
- `src/app/` dashboard pages, `src/app/api/agentos/*` routes, `src/app/components/*` client components.
- `src/db/schema.ts` Drizzle schema (`npx drizzle-kit push`).
- `tests/{unit,integration,e2e,recovery,stress,chaos}` (`node:test` + `tsx`), `tests/helpers.ts`, `tests.json` catalogue.
- `scripts/bench.ts` benchmark, `bin/agentos.js` CLI launcher.

## Commands
`npm test` · `npm run test:all` · `npm run lint` · `npm run typecheck` · `npm run build` · `npm run bench` · `npm run agentos -- <cmd>`.
Stress task count: `STRESS_TASKS=500 npm run test:stress`.

## Conventions
- Tools never throw for runtime failures — return structured data (`exitCode`, `error`) and reserve `ToolError` for policy/argument violations.
- Every state change goes through `AgentRuntime` and is followed by a persisted task/checkpoint write and an event.
- Never log raw args/results: always via the bus (redacted) or `redactSecrets`.
- Tests: fix the code, not the expectation. Add a regression test for each bug found.
- Test files are CommonJS-transpiled TypeScript (`.ts`, no top-level await); use `@/agentos/...` imports.

## Adding a tool
```ts
class MyTool implements Tool { name = "my"; description = "..."; actions = [{ name: "do", description: "...", params: { x: "string" } }];
  async execute(input, ctx) { if (ctx.signal.aborted) throw ctx.signal.reason; /* respect ctx.workdir + ctx.timeoutMs */ return {...}; } }
const { registry } = createDefaultToolRegistry(); registry.register(new MyTool());
await AgentRuntime.create({ tools: registry });
```
Add unit tests for: normal call, bad arguments, timeout/cancel, large output.

## Adding an agent
Implement `Agent<I, O>` in `agents.ts`, run it via `runAgent()` (emits `agent.*` events), wire it into `orchestrator.ts`.

## Extensions
- **Hooks** live in `.agentos/config.json` (`config.ts` validates, `HookRunner` executes). A `pre_tool_call` hook that
  exits 2 blocks the call (`HOOK_BLOCKED` is a fatal code); everything else is advisory. Registry integration:
  `tools/registry.ts`; task-level hooks fire in `runtime.ts` once a task reaches COMPLETED/FAILED.
- **MCP servers** are configured in the same file and connected by `mcp.ts` at runtime start; each MCP tool becomes a
  registry tool with a single `call` action (`mcp_<server>_<tool>`). Failures emit `mcp.failed` and are non-fatal.
- **Agentic mode**: `spec.mode: "agentic"` runs `AgenticLoopAgent` (agents.ts) instead of the step executor. Keep the
  invariants: per-tool-call checkpoints, budgets consumed through `BudgetGuard`, verification + reviewer untouched.
  The loop streams (`model.stream` with tools) and emits transient `model.delta` events; compaction kicks in past 100
  messages; `AGENTS.md`/`CLAUDE.md`/`AGENTOS.md` from the workdir are injected as project instructions.
- **Permissions**: `permissionMode: "confirm"` + `onPermissionRequest` on the runtime; the gate sits in
  `ToolRegistry.execute` before hooks; `PERMISSION_DENIED` is a fatal code.
- **Chat**: `chat.ts` — `chatTurn(rt, text, handlers, opts)` is the testable unit; `runChat` owns the readline loop and
  accepts injected `input`/`output` streams for tests (see tests/integration/chat-repl.test.ts). Note: pending
  `rl.question()` never settles on EOF on current Node — always race questions against the closed signal.
- **Mocked LLM**: `MockModelProvider` (tests/helpers.ts) scripts both `completeWithTools` and streaming `stream` turns;
  use it for model-driven tests so the suite stays offline and deterministic.
- **Optional tiers**: `test:smoke` needs `LLM_SMOKE=1` + `LLM_API_KEY`; the PG suite needs `TEST_DATABASE_URL`
  (points at an empty disposable database).
