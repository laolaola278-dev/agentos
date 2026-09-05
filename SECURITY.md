# SECURITY

Threat model: an autonomous agent executing tools on a developer machine. Goals: keep the agent inside its workspace,
keep secrets out of logs/stores, and make it impossible for a misbehaving tool/process to take down the runtime.

| Area | Control |
|---|---|
| Path traversal | `resolveSafePath(root, p)`: resolves against the (realpath'd) workdir, rejects `..` escapes, absolute paths outside root, NUL bytes, and symlinks whose target leaves the root. Applied by filesystem, terminal `cwd`, git paths, worktrees, verification `cwd`, acceptance checks. |
| Command execution | Commands run in bash inside the workdir with a **filtered environment**, their own process group (killed as a tree on timeout/cancel), output caps and stdin closed. A deny-list blocks obviously destructive commands (`rm -rf /`, `mkfs`, `dd if=`, fork bombs, `curl … | sh`, shutdown). Opt-out only via `allowDangerousCommands`. Shell semantics are otherwise intentionally available to the agent — the boundary is the workspace + policy, not shell parsing. |
| Git | Argument arrays (no shell); refs/branches may not start with `-`; no force-push, no history rewriting exposed; merges abort on conflict; identity injected via env. |
| HTTP | http/https only; cloud metadata hosts blocked; optional host allowlist; response size cap; timeouts; response headers redacted in logs. |
| Environment / secrets | Child processes receive an allowlist (`PATH, HOME, LANG, TERM, TMPDIR, NODE_ENV, CI, TZ …`) plus `AGENTOS_ALLOW_ENV`; variables whose names look secret are never forwarded unless explicitly allowed. `redactSecrets` runs on every event's args/result/data/error, on CLI/API output, and covers secret-like keys, known token formats (OpenAI, GitHub, AWS, Slack, Google, bearer, private keys, credentials in URLs, `key=value`) and the *values* of secret-looking env vars. The reviewer fails a task that writes secret-looking content. |
| Process escaping | `process` tool can only act on processes started by this runtime; timeouts/cancel send SIGTERM then SIGKILL to the process group; `ProcessManager` caps concurrent background processes and kills all task processes on task end/shutdown. |
| Protected paths | Reviewer rejects plans writing into `node_modules/` or `.git/`; filesystem refuses to delete the workdir root. |
| Resource limits | Tool output truncation, read size caps, list/search caps, event payload truncation, bounded pending-event buffer, budgets (tool calls, tokens, wall clock, retries). |
| Storage integrity | Atomic file writes (tmp + fsync + rename); JSONL reader tolerates a torn trailing line; corrupt task/checkpoint files are skipped; SQLite WAL + busy timeout. |

Known limitations: commands are not sandboxed by the OS (no seccomp/containers) — a determined command can still reach
outside the workdir through absolute paths; use containers for untrusted goals. LLM output is validated structurally
(tools/actions/args) but not semantically. Secret detection is pattern based.
