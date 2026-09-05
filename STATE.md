# STATE

- Phase: 15 — COMPLETE (project fully polished: harness parity set, security, orchestration, eval loop — see TODO.md)
- Current task: none
- Completed modules: everything in TODO.md phases 1–15
  - core runtime, orchestrator (plan + agentic modes, parallel tool calls), tools + subagent tool, CLI, dashboard, docs
  - model layer: text / native tool-calling / SSE streaming + malformed-argument repair + maxTokensField auto-flip
  - extensions: lifecycle hooks + MCP servers (stdio + Streamable HTTP) via `.agentos/config.json`
  - sandbox tiers: none / process (ulimit vmem+pids+cpu, platform-injectable) / container (read-only rootfs, caps)
  - secrets vault + provider profiles (github-models/deepseek/glm/ollama/custom) with quirk adaptation
  - interactive: `agentos chat` with confirm gate, permission policy table, session persistence + --resume, slash registry
  - capability uplift: context engineering (cleanToolResult/notes/budget), skills with injection scan, workspace repo-map,
    scoped API keys, deterministic eval loop with built-in `core` preset
- Blockers: none
- Next: optional — real-LLM smoke once a key exists; kernel-level sandbox (Landlock/Job Object) behind native bindings
- Last test result: `TEST_DATABASE_URL=... npm run test:all` → 161 tests, 160 passed / 0 failed / 1 skipped (container
  sandbox tier — Docker daemon down on this box); lint clean; typecheck clean; next build OK. Suites: unit 98,
  integration 42 (incl. real-PG regression + chat REPL + MCP HTTP), e2e 2, recovery 5, chaos 5, stress 4.
  Optional tiers: `test:smoke` (real LLM, requires LLM_SMOKE=1 + key), `test:serial` (loaded machines).
