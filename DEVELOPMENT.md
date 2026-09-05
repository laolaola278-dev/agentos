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
