import path from "node:path";
import type { Tool, ToolActionDef, ToolContext, ToolInput, ModelProvider, TaskSpec, AcceptanceCheck } from "../types";
import { ToolError } from "../types";
import type { ToolRegistry } from "./registry";
import { AgentRuntime } from "../runtime";
import { cleanToolResult } from "../context";
import type { SandboxConfig } from "../sandbox";

/**
 * Isolated sub-agent tool (Claude Code "Task"/subagents equivalent).
 *
 * The parent agentic loop can delegate a self-contained piece of work to a child
 * runtime that has: a FRESH conversation (no parent transcript), its own memory
 * persistence and checkpoints, and a tool registry WITHOUT the subagent tool
 * (no recursive spawning). Context isolation is the point — the parent model
 * sees only a capped result object (status + summary + counters), never the
 * child's transcript.
 */

export interface SubagentToolOptions {
  model: ModelProvider | null;
  rootDir: string;
  /** Parent data dir; child scratch spaces live under `<dataDir>/subagents/`. */
  dataDir: string;
  sandbox?: SandboxConfig;
  shell?: string;
  /** Builds a fresh child tool registry — must NOT contain the subagent tool. */
  childRegistry: () => ToolRegistry;
  allowDangerous?: boolean;
  maxConcurrent?: number;
}

export class SubagentTool implements Tool {
  name = "subagent";
  description = "Delegate a self-contained sub-task to an isolated sub-agent with a fresh context; returns its status and a short summary only";
  actions: ToolActionDef[] = [
    {
      name: "run",
      description: "Run an isolated sub-agent on a goal. In plan mode provide explicit steps; in agentic mode an LLM drives the child run.",
      params: { goal: "string", mode: "plan|agentic?", instructions: "string?", tools: "string[]?", steps: "any?", acceptance: "any?", maxToolCalls: "number?" },
    },
  ];
  private running = 0;

  constructor(private opts: SubagentToolOptions) {}

  async execute(input: ToolInput, ctx: ToolContext): Promise<unknown> {
    const a = input.args ?? {};
    const maxConcurrent = this.opts.maxConcurrent ?? 2;
    if (this.running >= maxConcurrent) throw new ToolError("TOO_MANY_PROCESSES", `sub-agent concurrency cap (${maxConcurrent}) reached`, { retryable: true });
    const goal = typeof a.goal === "string" ? a.goal.trim() : "";
    if (!goal) throw new ToolError("MISSING_ARGUMENT", "subagent.run requires a goal");
    const mode = a.mode === "agentic" ? "agentic" : "plan";
    if (mode === "agentic" && !this.opts.model) throw new ToolError("MODEL_REQUIRED", "agentic subagents require an LLM provider");
    if (mode === "plan" && !Array.isArray(a.steps)) throw new ToolError("INVALID_ARGUMENT", "plan-mode subagent.run requires a steps array");
    // specialized sub-agent instructions (Claude Code custom-subagent equivalent)
    const instructions = typeof a.instructions === "string" ? a.instructions.trim().slice(0, 4000) : "";

    const spec: TaskSpec = {
      title: goal.slice(0, 80),
      goal: instructions ? `${goal}\n\nSub-agent instructions:\n${instructions}` : goal,
      mode,
      workdir: ctx.workdir,
      budget: { maxToolCalls: typeof a.maxToolCalls === "number" ? Math.min(Math.max(1, a.maxToolCalls), 200) : 50, timeoutMs: 5 * 60_000 },
    };
    if (Array.isArray(a.steps)) spec.steps = a.steps as TaskSpec["steps"];
    if (Array.isArray(a.acceptance)) spec.acceptance = a.acceptance as AcceptanceCheck[];

    this.running++;
    const childDataDir = path.join(this.opts.dataDir, "subagents", `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    // tool allowlist (Claude Code subagent `tools:` semantics): the child only
    // sees the allow-listed tools/actions; everything else is invisible
    const toolAllowlist = Array.isArray(a.tools) ? (a.tools as string[]).filter((p) => typeof p === "string") : [];
    const child = await AgentRuntime.create({
      rootDir: this.opts.rootDir,
      dataDir: childDataDir,
      persistence: "memory",
      model: mode === "agentic" ? this.opts.model : null,
      tools: this.opts.childRegistry().filteredView(toolAllowlist),
      concurrency: 1,
      controlPollMs: 0,
      sandbox: this.opts.sandbox,
      shell: this.opts.shell,
      allowDangerousCommands: this.opts.allowDangerous,
      jsonlMirror: false,
    });
    try {
      const task = await child.createTask(spec);
      await child.startTask(task.id);
      const done = await child.waitForTask(task.id);
      const stepLine = (done.result?.stepResults ?? []).map((r) => `${r.tool}.${r.action}=${r.ok ? "ok" : "FAILED"}`).join(", ");
      const raw = {
        status: done.status,
        summary: done.result?.finalMessage ?? `${done.result?.summary ?? done.status}${stepLine ? ` (${stepLine})` : ""}`,
        error: done.error ?? null,
        tokens: done.usage.tokens,
        toolCalls: done.usage.toolCalls,
        elapsedMs: done.usage.elapsedMs,
      };
      // context isolation: the parent sees the cleaned result object only
      return cleanToolResult(raw, { maxStringChars: 2000 }).data;
    } finally {
      this.running--;
      await child.close().catch(() => undefined);
    }
  }
}
