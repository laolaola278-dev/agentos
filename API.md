# API

## HTTP (Next.js, `src/app/api/agentos`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/agentos/tasks?status=A,B` | List tasks (results omitted), running count, concurrency |
| POST | `/api/agentos/tasks` | Create a task. Body = `TaskSpec` (+ `start: false` to only create). Returns 201 `{task}` |
| GET | `/api/agentos/tasks/:id` | `{task, checkpoint, eventCount}` |
| POST | `/api/agentos/tasks/:id/action` | `{action: "start"|"pause"|"resume"|"cancel"|"retry"|"recover"}` |
| GET | `/api/agentos/events?taskId&agentId&type&typePrefix&afterId&limit` | Query the event log |
| GET | `/api/agentos/events/stream?taskId&typePrefix&afterId` | Server-Sent Events: `event`, `task`, `ping`, `error` |
| GET | `/api/agentos/metrics[?format=prometheus]` | Metrics snapshot (JSON) or Prometheus text |
| GET | `/api/agentos/agents` | Agent catalog + active tasks per role + timings |
| GET | `/api/agentos/tools` | Tool catalog + per-tool metrics |
| GET | `/api/agentos/doctor` | Environment/store diagnostics |
| GET | `/api/health` | DB liveness |

All responses pass through `redactSecrets`. Errors: `{error, code}` with 400/404/500.

### TaskSpec

```ts
{
  title: string; goal: string; priority?: number; dependsOn?: string[];
  steps?: { id: string; tool: string; action: string; args: object; expect?: { exitCode?, stdoutIncludes?, ok? }; retryable?: boolean; timeoutMs?: number }[];
  verification?: { name: string; kind: "unit"|"integration"|"e2e"|"lint"|"typecheck"|"build"|"custom"; command: string; cwd?: string; timeoutMs?: number }[];
  acceptance?: { type: "file_exists"|"file_contains"|"file_not_contains"|"command_succeeds"; path?; text?; command? }[];
  budget?: { maxRetries?: number; timeoutMs?: number; maxToolCalls?: number; maxTokens?: number };
  workdir?: string; isolated?: boolean; tags?: string[];
  mode?: "plan" | "agentic";   // agentic: LLM drives the tool registry (needs LLM_API_KEY with tool calling)
}
```

## Programmatic (TypeScript)

```ts
import { AgentRuntime } from "@/agentos";
const rt = await AgentRuntime.create({ rootDir, persistence: "sqlite" | "file" | "memory" | customPersistence, concurrency: 4, model: null });
const task = await rt.createTask(spec);
await rt.startTask(task.id);        // enqueue (scheduler respects priority + dependencies)
await rt.runTask(task.id);          // enqueue + wait
await rt.pauseTask(id); await rt.resumeTask(id); await rt.cancelTask(id); await rt.retryTask(id);
await rt.recoverTask(id); await rt.recoverAll();
rt.bus.subscribe(handler, { taskId }); for await (const e of rt.bus.stream({ typePrefix: "tool." }, signal)) {...}
await rt.bus.replay({ taskId }, handler);
rt.metrics.snapshot(); rt.metrics.toPrometheus(); await rt.doctor(); rt.listTools(); rt.listAgents();
rt.startDaemon(); await rt.close();
```

Extending: implement `Tool` and `registry.register(tool)` (pass `tools` to `AgentRuntime.create`); implement `Persistence`
for another store; implement `ModelProvider` for another LLM API (`completeWithTools` enables agentic mode).
Runtime options accept `config` (`hooks` + `mcpServers`, also auto-loaded from `<dataDir>/config.json`; see README).

## Tools

`filesystem`: read, write, append, edit, apply_patch, patch, delete, move, copy, list, search, mkdir, stat, exists ·
`terminal`: execute, start, poll, stop · `process`: list, kill, wait, output ·
`git`: status, diff, log, branch, checkout, add, commit, stash, init, rev_parse, state, worktree_add, worktree_remove, merge, branch_delete, clone ·
`http`: get, post, request. Run `agentos tools list` for parameters.
