# TROUBLESHOOTING

| Symptom | Cause / fix |
|---|---|
| `PLAN_UNAVAILABLE: cannot derive an executable plan` | The goal is free-form prose and no LLM is configured. Use the goal DSL, pass `--step`, or set `LLM_API_KEY`. |
| `PLAN_INVALID: unrecognised goal instruction` | A line starts with a DSL keyword but does not match its syntax (e.g. `write` without `path:`). |
| Task FAILED with `BUDGET_EXCEEDED` | Raise `--max-tool-calls` / `--timeout` or reduce the plan. Budget failures are never retried by design. |
| `FIX_ATTEMPTS_EXHAUSTED` | Self-correction ran `maxRetries` times. Read `.agentos/failures/FAILURE_ANALYSIS-<id>.md`. |
| `UNRECOVERABLE: step … failed` | The step failed with a non-retryable error (bad args, blocked command, path traversal). Fix the spec. |
| `DANGEROUS_COMMAND` | Command matched the destructive deny-list. Rephrase, or run with `allowDangerousCommands` programmatically. |
| `PATH_TRAVERSAL` | A path pointed outside the workdir (including through a symlink). |
| Task stuck in EXECUTING after a crash | Run `agentos recover` (or open the dashboard; it recovers on boot). `agentos doctor` lists interrupted tasks. |
| `RECOVERY_FAILED: workdir missing` | The checkpointed workdir was deleted; recreate it and `agentos task retry <id>`. |
| `git HEAD changed since checkpoint` warning | Someone committed while the task was down; resume continues but review git state carefully. |
| `MERGE_CONFLICT` on isolated task | The base branch changed concurrently. The worktree was removed, branch `agentos/<id>` is kept; merge manually or retry. |
| `--store pg requires DATABASE_URL` | Put `DATABASE_URL` in `.env` (root dir) and run `npx drizzle-kit push`. |
| `ExperimentalWarning: SQLite` | Harmless (Node 22 `node:sqlite`). `NODE_NO_WARNINGS=1` silences it (the launcher sets it). |
| Dashboard shows no tool metrics | Metrics are per-process; the dashboard only sees tool calls executed in the Next server. Events/tasks are shared via PG. |
| Pause seems slow | Pause takes effect when the current tool call yields (running commands are killed as a tree, so this is bounded by the tool timeout). |
| `EBUSY` / SQLite busy | Another process holds the DB; `busy_timeout` is 5 s. Use one daemon per data dir. |
