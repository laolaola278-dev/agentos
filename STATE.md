# STATE

- Phase: 18 — COMPLETE (search glob, repo-map, token compaction, subagent roles, Windows sandbox fail-closed)
- Current task: none
- Completed modules: everything in TODO.md phases 1–18
  - core runtime, orchestrator (plan + agentic modes, read-only-only parallel tool calls), tools + subagent tool, CLI, dashboard, docs
  - model layer: text / native tool-calling / SSE streaming + malformed-argument repair + maxTokensField auto-flip
  - extensions: lifecycle hooks + MCP servers (stdio + Streamable HTTP) via `.agentos/config.json`
  - sandbox tiers: none / process (ulimit vmem+pids+cpu, platform-injectable) / container (read-only rootfs, caps)
  - secrets vault + provider profiles (github-models/deepseek/glm/ollama/custom) with quirk adaptation
  - interactive: `agentos chat` with confirm gate, permission policy table, session persistence + --resume, slash registry
  - capability uplift: context engineering (cleanToolResult/notes/budget), skills with injection scan, workspace repo-map,
    scoped API keys, deterministic eval loop with built-in `core` preset
- Blockers: none
- Next: optional — real-LLM smoke once a key exists; kernel-level sandbox (Landlock/Job Object) behind native bindings
- Last test result: phase-18 suites 51 passed / 1 skipped (container sandbox — Docker daemon down).
  Covered: tools, repomap, extensions, sandbox unit, agentic integration, sandbox integration.
  `tsc --noEmit` clean. Full `test:all` not re-run this round.
