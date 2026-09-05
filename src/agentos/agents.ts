import path from "node:path";
import fsp from "node:fs/promises";
import type {
  AcceptanceCheck,
  AcceptanceResult,
  AgentRole,
  Budget,
  Checkpoint,
  Diagnosis,
  Message,
  ModelProvider,
  ModelToolCompletion,
  Plan,
  ReviewIssue,
  ReviewResult,
  StepResult,
  StepSpec,
  Task,
  ToolOutput,
  ToolSchema,
  VerificationResult,
  VerificationSpec,
} from "./types";
import { AgentOSError, BudgetExceededError, nowIso } from "./types";
import type { ToolRegistry } from "./tools/registry";
import type { EventBus } from "./events";
import type { VerificationEngine } from "./verification";
import { extractJson, repairToolArguments } from "./model";
import { redactString } from "./security";
import { getGitState, runGit } from "./tools/git";
import { cleanToolResult, NotesStore } from "./context";
import { skillsPromptSection, type Skill } from "./skills";
import { buildRepoMap } from "./repomap";

// ---------------------------------------------------------------------------
// Budget guard
// ---------------------------------------------------------------------------

export class BudgetGuard {
  constructor(
    readonly budget: Budget,
    readonly usage: { toolCalls: number; tokens: number; elapsedMs: number },
    private readonly startedAt: number,
    private readonly priorElapsedMs: number,
  ) {}

  elapsedMs(): number {
    return this.priorElapsedMs + (Date.now() - this.startedAt);
  }
  remainingMs(): number {
    return Math.max(0, this.budget.timeoutMs - this.elapsedMs());
  }
  checkDeadline(): void {
    if (this.elapsedMs() > this.budget.timeoutMs) throw new BudgetExceededError("timeout", this.budget.timeoutMs, this.elapsedMs());
  }
  consumeToolCall(): void {
    this.checkDeadline();
    if (this.usage.toolCalls + 1 > this.budget.maxToolCalls) throw new BudgetExceededError("toolCalls", this.budget.maxToolCalls, this.usage.toolCalls + 1);
    this.usage.toolCalls++;
  }
  consumeTokens(n: number): void {
    this.usage.tokens += n;
    if (this.usage.tokens > this.budget.maxTokens) throw new BudgetExceededError("tokens", this.budget.maxTokens, this.usage.tokens);
  }
}

// ---------------------------------------------------------------------------
// Agent context / base
// ---------------------------------------------------------------------------

export interface AgentContext {
  task: Task;
  checkpoint: Checkpoint;
  tools: ToolRegistry;
  bus: EventBus;
  signal: AbortSignal;
  model: ModelProvider | null;
  verification: VerificationEngine;
  budget: BudgetGuard;
  workdir: string;
  artifactsDir: string;
  shell?: string;
  /** User-authored skills injected into agentic system prompts (E5). */
  skills?: Skill[];
  /** Agentic loop behaviour (parallel tool calls). */
  agentic?: Required<import("./config").AgenticConfig>;
}

export interface Agent<I, O> {
  role: AgentRole;
  run(ctx: AgentContext, input: I): Promise<O>;
}

let agentCounter = 0;
export function newAgentId(role: AgentRole, taskId: string): string {
  return `${role}-${taskId.slice(-6)}-${(++agentCounter).toString(36)}`;
}

/** Wraps an agent run with lifecycle events; errors propagate after being recorded. */
export async function runAgent<I, O>(agent: Agent<I, O>, ctx: AgentContext, input: I): Promise<{ output: O; agentId: string }> {
  const agentId = newAgentId(agent.role, ctx.task.id);
  const started = Date.now();
  await ctx.bus.emit({ taskId: ctx.task.id, agentId, type: "agent.started", data: { role: agent.role, attempt: ctx.task.attempt } });
  try {
    const output = await agent.run({ ...ctx }, input);
    await ctx.bus.emit({ taskId: ctx.task.id, agentId, type: "agent.completed", durationMs: Date.now() - started, data: { role: agent.role } });
    return { output, agentId };
  } catch (err) {
    await ctx.bus.emit({
      taskId: ctx.task.id,
      agentId,
      type: "agent.failed",
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      data: { role: agent.role, code: (err as AgentOSError)?.code },
    });
    throw err;
  }
}

function pushMessage(ctx: AgentContext, role: Message["role"], content: string, agent: AgentRole) {
  ctx.checkpoint.messages.push({ role, content: content.slice(0, 8000), ts: nowIso(), agent });
  if (ctx.checkpoint.messages.length > 200) ctx.checkpoint.messages.splice(0, ctx.checkpoint.messages.length - 200);
}

async function askModel(ctx: AgentContext, agent: AgentRole, system: string, user: string): Promise<string> {
  if (!ctx.model) throw new AgentOSError("NO_MODEL", "no model provider configured");
  const messages: Message[] = [
    { role: "system", content: system, ts: nowIso() },
    ...ctx.checkpoint.messages.slice(-12),
    { role: "user", content: user, ts: nowIso() },
  ];
  const res = await ctx.model.complete(messages, { json: true, signal: ctx.signal });
  ctx.budget.consumeTokens(res.tokens);
  await ctx.bus.emit({ taskId: ctx.task.id, agentId: null, type: "model.completed", data: { agent, tokens: res.tokens, provider: ctx.model.name } });
  pushMessage(ctx, "assistant", res.content, agent);
  return res.content;
}

// ---------------------------------------------------------------------------
// Researcher
// ---------------------------------------------------------------------------

export interface ResearchReport {
  files: string[];
  packageScripts: Record<string, string>;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  git: { isRepo: boolean; branch?: string; head?: string; dirty?: boolean };
  suggestedVerification: VerificationSpec[];
  notes: string[];
  /** Aider-style structural index of the workspace (may be empty). */
  repoMap: string;
}

export class ResearcherAgent implements Agent<void, ResearchReport> {
  role: AgentRole = "researcher";
  async run(ctx: AgentContext): Promise<ResearchReport> {
    const notes: string[] = [];
    ctx.budget.consumeToolCall();
    const listing = await ctx.tools.execute("filesystem", { action: "list", args: { path: ".", maxEntries: 200 } }, { taskId: ctx.task.id, agentId: "researcher", workdir: ctx.workdir, signal: ctx.signal, bus: ctx.bus, shell: ctx.shell });
    const files = listing.ok ? ((listing.data as { entries: { path: string }[] }).entries.map((e) => e.path)) : [];
    if (!listing.ok) notes.push(`could not list workdir: ${listing.error?.message}`);
    let packageScripts: Record<string, string> = {};
    let packageManager: ResearchReport["packageManager"] = null;
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(ctx.workdir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      packageScripts = pkg.scripts ?? {};
      packageManager = files.includes("pnpm-lock.yaml") ? "pnpm" : files.includes("yarn.lock") ? "yarn" : files.includes("bun.lockb") ? "bun" : "npm";
    } catch {
      notes.push("no package.json in workdir");
    }
    const git = await getGitState(ctx.workdir, ctx.signal);
    const suggestedVerification: VerificationSpec[] = [];
    for (const [name, kind] of [["test", "unit"], ["lint", "lint"], ["typecheck", "typecheck"], ["build", "build"]] as const) {
      if (packageScripts[name]) suggestedVerification.push({ name, kind, command: `${packageManager ?? "npm"} run ${name}` });
    }
    let repoMap = "";
    try {
      repoMap = (await buildRepoMap(ctx.workdir, { maxChars: 3000 })).map;
    } catch {
      // best-effort structural context
    }
    const report = { files, packageScripts, packageManager, git, suggestedVerification, notes, repoMap };
    pushMessage(ctx, "tool", `research: ${JSON.stringify({ ...report, files: files.slice(0, 50) })}`, "researcher");
    return report;
  }
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM = `You are the Planner of AgentOS. Produce a JSON object {"rationale": string, "steps": [{"id": string, "tool": string, "action": string, "args": object, "description": string, "retryable": boolean}]}.
Only use the tools/actions listed. Paths are relative to the workdir. Keep plans minimal and verifiable.`;

export class PlannerAgent implements Agent<{ research: ResearchReport | null }, Plan> {
  role: AgentRole = "planner";

  async run(ctx: AgentContext, input: { research: ResearchReport | null }): Promise<Plan> {
    const spec = ctx.task.spec;
    let plan: Plan;
    if (spec.steps && spec.steps.length > 0) {
      plan = { steps: spec.steps.map((s, i) => ({ ...s, id: s.id || `step-${i + 1}` })), rationale: "explicit steps provided by task spec", source: "spec" };
    } else {
      const parsed = parseGoalDsl(spec.goal);
      if (parsed.steps.length > 0) {
        plan = { steps: parsed.steps, rationale: "derived from goal DSL", source: "heuristic" };
        if (parsed.verification.length && !spec.verification?.length) spec.verification = parsed.verification;
        if (parsed.acceptance.length && !spec.acceptance?.length) spec.acceptance = parsed.acceptance;
      } else if (ctx.model) {
        const toolsDoc = ctx.tools.list().map((t) => `${t.name}: ${t.actions.map((a) => `${a.name}(${Object.entries(a.params).map(([k, v]) => `${k}:${v}`).join(", ")})`).join("; ")}`).join("\n");
        const user = `Goal: ${spec.goal}\n\nAvailable tools:\n${toolsDoc}\n\nWorkspace research: ${JSON.stringify(input.research ?? {}).slice(0, 4000)}`;
        const raw = await askModel(ctx, "planner", PLANNER_SYSTEM, user);
        const json = extractJson<{ rationale?: string; steps?: StepSpec[] }>(raw);
        if (!Array.isArray(json.steps) || json.steps.length === 0) throw new AgentOSError("PLAN_EMPTY", "model returned an empty plan");
        plan = { steps: json.steps.map((s, i) => ({ ...s, id: s.id || `step-${i + 1}`, args: s.args ?? {} })), rationale: json.rationale ?? "model plan", source: "model" };
      } else {
        throw new AgentOSError(
          "PLAN_UNAVAILABLE",
          "cannot derive an executable plan: provide `steps`, use the goal DSL (write/append/mkdir/run/verify/check ...), or configure LLM_API_KEY",
        );
      }
    }
    validatePlan(plan, ctx.tools);
    pushMessage(ctx, "assistant", `plan(${plan.source}): ${plan.steps.map((s) => `${s.id}=${s.tool}.${s.action}`).join(", ")}`, "planner");
    await ctx.bus.emit({ taskId: ctx.task.id, agentId: null, type: "task.planned", data: { source: plan.source, steps: plan.steps.length, rationale: plan.rationale } });
    return plan;
  }
}

export function validatePlan(plan: Plan, tools: ToolRegistry): void {
  const ids = new Set<string>();
  if (plan.steps.length > 500) throw new AgentOSError("PLAN_TOO_LARGE", `plan has ${plan.steps.length} steps (max 500)`);
  for (const s of plan.steps) {
    if (!s.id || typeof s.id !== "string" || s.id.length > 200 || ids.has(s.id)) throw new AgentOSError("PLAN_INVALID", `duplicate or missing step id: ${s.id}`);
    ids.add(s.id);
    const tool = tools.get(s.tool);
    const action = tool?.actions.find((a) => a.name === s.action);
    if (!tool || !action) throw new AgentOSError("PLAN_INVALID", `step ${s.id} uses unknown tool/action ${s.tool}.${s.action}`);
    if (!s.args || typeof s.args !== "object") throw new AgentOSError("PLAN_INVALID", `step ${s.id} has no args object`);
    validateActionArgs(s.id, action.params, s.args);
  }
}

function validateActionArgs(stepId: string, params: Record<string, string>, args: Record<string, unknown>): void {
  for (const [name, descriptor] of Object.entries(params)) {
    const optional = descriptor.endsWith("?");
    const type = descriptor.replace(/\?$/, "");
    const value = args[name];
    if (value === undefined || value === null) {
      if (!optional) throw new AgentOSError("PLAN_INVALID", `step ${stepId} is missing required argument ${name}`);
      continue;
    }
    const valid = type === "any" || (type === "string" && typeof value === "string") || (type === "number" && typeof value === "number" && Number.isFinite(value)) || (type === "boolean" && typeof value === "boolean") || (type === "object" && typeof value === "object" && !Array.isArray(value)) || (type === "string[]" && Array.isArray(value) && value.every((v) => typeof v === "string"));
    if (!valid) throw new AgentOSError("PLAN_INVALID", `step ${stepId} argument ${name} must be ${type}`);
  }
}

/** Deterministic goal DSL — one instruction per line. */
export function parseGoalDsl(goal: string): { steps: StepSpec[]; verification: VerificationSpec[]; acceptance: AcceptanceCheck[] } {
  const steps: StepSpec[] = [];
  const verification: VerificationSpec[] = [];
  const acceptance: AcceptanceCheck[] = [];
  const unescape = (s: string) => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  let n = 0;
  const id = (prefix: string) => `${prefix}-${++n}`;
  for (const rawLine of goal.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^write\s+(\S+)\s*:\s?(.*)$/))) steps.push({ id: id("write"), tool: "filesystem", action: "write", args: { path: m[1], content: unescape(m[2]) }, description: line });
    else if ((m = line.match(/^append\s+(\S+)\s*:\s?(.*)$/))) steps.push({ id: id("append"), tool: "filesystem", action: "append", args: { path: m[1], content: unescape(m[2]) }, description: line });
    else if ((m = line.match(/^mkdir\s+(\S+)$/))) steps.push({ id: id("mkdir"), tool: "filesystem", action: "mkdir", args: { path: m[1] }, description: line });
    else if ((m = line.match(/^delete\s+(\S+)$/))) steps.push({ id: id("delete"), tool: "filesystem", action: "delete", args: { path: m[1], recursive: true }, description: line });
    else if ((m = line.match(/^run\s*:\s*(.+)$/))) steps.push({ id: id("run"), tool: "terminal", action: "execute", args: { command: m[1] }, description: line, retryable: true });
    else if ((m = line.match(/^fetch\s+(\S+)$/))) steps.push({ id: id("fetch"), tool: "http", action: "get", args: { url: m[1] }, description: line, retryable: true });
    else if ((m = line.match(/^git\s*:\s*(\w+)\s*(\{.*\})?$/))) {
      let args: Record<string, unknown> = {};
      if (m[2]) {
        try {
          args = JSON.parse(m[2]) as Record<string, unknown>;
        } catch {
          throw new AgentOSError("PLAN_INVALID", `invalid JSON args in goal line: ${line}`);
        }
      }
      steps.push({ id: id("git"), tool: "git", action: m[1], args, description: line });
    } else if ((m = line.match(/^verify\s*:\s*(.+)$/))) verification.push({ name: `verify-${verification.length + 1}`, kind: "custom", command: m[1] });
    else if ((m = line.match(/^check\s+exists\s+(\S+)$/))) acceptance.push({ type: "file_exists", path: m[1], description: line });
    else if ((m = line.match(/^check\s+contains\s+(\S+)\s*:\s?(.*)$/))) acceptance.push({ type: "file_contains", path: m[1], text: unescape(m[2]), description: line });
    else if ((m = line.match(/^check\s+not-contains\s+(\S+)\s*:\s?(.*)$/))) acceptance.push({ type: "file_not_contains", path: m[1], text: unescape(m[2]), description: line });
    else if ((m = line.match(/^check\s+command\s*:\s*(.+)$/))) acceptance.push({ type: "command_succeeds", command: m[1], description: line });
    else if (/^(write|append|mkdir|delete|run|fetch|git|verify|check)\b/.test(line)) {
      throw new AgentOSError("PLAN_INVALID", `unrecognised goal instruction: ${line.slice(0, 120)}`);
    }
  }
  return { steps, verification, acceptance };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface ExecuteInput {
  steps: StepSpec[];
  /** Called after each successful step so the orchestrator can checkpoint. */
  onStep: (result: StepResult) => Promise<void>;
  label?: string;
}

export interface ExecuteOutput {
  results: StepResult[];
  failed: StepResult | null;
}

export class ExecutorAgent implements Agent<ExecuteInput, ExecuteOutput> {
  role: AgentRole = "executor";

  async run(ctx: AgentContext, input: ExecuteInput): Promise<ExecuteOutput> {
    const results: StepResult[] = [];
    for (const step of input.steps) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const maxAttempts = step.retryable ? 2 : 1;
      let result: StepResult | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        ctx.budget.consumeToolCall();
        await ctx.bus.emit({ taskId: ctx.task.id, agentId: "executor", type: "agent.tool_call", tool: step.tool, args: { stepId: step.id, action: step.action, attempt }, data: { description: step.description } });
        const started = Date.now();
        const output = await ctx.tools.execute(
          step.tool,
          { action: step.action, args: step.args },
          { taskId: ctx.task.id, agentId: "executor", workdir: ctx.workdir, signal: ctx.signal, timeoutMs: step.timeoutMs ?? Math.min(ctx.budget.remainingMs() || 1, 10 * 60_000), bus: ctx.bus, shell: ctx.shell },
        );
        const expectError = output.ok ? checkExpectation(step, output.data) : null;
        result = {
          stepId: step.id,
          tool: step.tool,
          action: step.action,
          ok: output.ok && !expectError,
          output,
          error: output.ok ? expectError ?? undefined : `${output.error?.code}: ${output.error?.message}`,
          durationMs: Date.now() - started,
          attempt,
          finishedAt: nowIso(),
        };
        if (result.ok) break;
        if (ctx.signal.aborted) throw ctx.signal.reason;
        const retryable = output.error?.retryable ?? false;
        if (attempt < maxAttempts && (retryable || step.retryable)) {
          await ctx.bus.emit({ taskId: ctx.task.id, agentId: "executor", type: "agent.retry", data: { stepId: step.id, attempt, reason: result.error } });
          await sleep(Math.min(250 * attempt, 2000), ctx.signal);
          continue;
        }
        break;
      }
      results.push(result!);
      pushMessage(ctx, "tool", `${step.id} ${step.tool}.${step.action} -> ${result!.ok ? "ok" : `FAILED ${result!.error}`}`, "executor");
      if (!result!.ok) return { results, failed: result! };
      await input.onStep(result!);
    }
    return { results, failed: null };
  }
}

function checkExpectation(step: StepSpec, data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (step.tool === "terminal" && step.action === "execute") {
    const expected = step.expect?.exitCode ?? 0;
    if (d.exitCode !== expected) return `expected exit code ${expected}, got ${d.exitCode}${d.stderr ? `: ${String(d.stderr).slice(0, 500)}` : ""}`;
    if (step.expect?.stdoutIncludes !== undefined && !String(d.stdout ?? "").includes(step.expect.stdoutIncludes)) return `stdout does not include ${JSON.stringify(step.expect.stdoutIncludes)}`;
  }
  if (step.tool === "http" && step.expect?.ok !== undefined && d.ok !== step.expect.ok) return `expected http ok=${step.expect.ok}, got status ${d.status}`;
  if (step.expect?.ok === false && step.tool !== "http") return null;
  return null;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Agentic loop — the model drives the tool registry directly (Claude Code /
// Codex style). The harness stays in charge of budgets, checkpoints, the
// verification engine and the independent reviewer, so an agentic task can
// still only complete with objective evidence.
// ---------------------------------------------------------------------------

/** Builds OpenAI function-calling schemas from the registry: one tool per `tool.action`. */
export function toolSchemasFromRegistry(registry: ToolRegistry): { schemas: ToolSchema[]; resolve: (name: string) => { tool: string; action: string } | null } {
  const schemas: ToolSchema[] = [];
  const index = new Map<string, { tool: string; action: string }>();
  // Claude Code semantics: a bare-tool deny removes the tool from the model's
  // tool list entirely (not just blocks execution); action-level denies hide
  // that action's schema so the model never wastes a call on it.
  const policy = registry.permissionPolicySnapshot;
  const toolDenied = (tool: string) => policy.deny.some((p) => p === tool || p === `${tool}.*`);
  const actionDenied = (tool: string, action: string) => policy.deny.some((p) => p === `${tool}.${action}`);
  for (const t of registry.list()) {
    if (toolDenied(t.name)) continue;
    for (const a of t.actions) {
      if (actionDenied(t.name, a.name)) continue;
      const name = `${t.name}__${a.name}`;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [param, descriptor] of Object.entries(a.params)) {
        const optional = descriptor.endsWith("?");
        const base = optional ? descriptor.slice(0, -1) : descriptor;
        let schema: Record<string, unknown>;
        if (base === "number") schema = { type: "number" };
        else if (base === "boolean") schema = { type: "boolean" };
        else if (base === "object") schema = { type: "object" };
        else if (base === "string[]") schema = { type: "array", items: { type: "string" } };
        else if (base === "any") schema = {};
        else if (base.includes("|")) schema = { type: "string", enum: base.split("|") };
        else schema = { type: "string" };
        properties[param] = schema;
        if (!optional) required.push(param);
      }
      schemas.push({ name, description: `${t.name} tool, action "${a.name}": ${a.description}`, parameters: { type: "object", properties, required } });
      index.set(name, { tool: t.name, action: a.name });
    }
  }
  return { schemas, resolve: (name) => index.get(name) ?? null };
}

function summariseForModel(output: ToolOutput, maxChars = 4000): string {
  // E1: clean the payload BEFORE it enters the model conversation (head+tail
  // strings, sliced arrays, stripped noisy keys). The full payload is already
  // in the event log for the reviewer — the model only needs the signal.
  const cleaned = cleanToolResult({ ok: output.ok, data: output.data, error: output.error, truncated: output.truncated });
  let json = JSON.stringify(cleaned.data) ?? "{}";
  if (json.length > maxChars) json = json.slice(0, maxChars) + `…[truncated, ${json.length} chars total]`;
  return json;
}

/** Drops oldest whole tool-call turns, always keeping the system message and result/assistant pairing intact. */
export function trimConversation(messages: Message[], max = 60): Message[] {
  if (messages.length <= max) return messages;
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const keep = Math.max(4, max - system.length);
  let start = 0;
  let units = rest.length;
  while (units > keep && start < rest.length) {
    const m = rest[start];
    start++;
    units--;
    if (m.role === "assistant" && m.toolCalls?.length) {
      const ids = new Set(m.toolCalls.map((c) => c.id));
      while (start < rest.length && rest[start].role === "tool" && ids.has(rest[start].toolCallId ?? "")) {
        start++;
        units--;
      }
    }
  }
  return [...system, ...rest.slice(start)];
}

export const AGENTIC_SYSTEM = `You are an autonomous software-engineering agent working inside a sandboxed workspace on the user's machine.
Achieve the goal by calling tools yourself, one step at a time, observing each result before deciding the next action.
Rules:
- Stay inside the workspace; paths are relative to it.
- Prefer small, verifiable steps (write files, run commands) over big speculative ones.
- Re-read files you did not write before editing them.
- When you believe the goal is met, respond with a short summary and NO tool call. The harness will still run independent verification and review.`;

const MAX_COMPACTION_MESSAGES = 100;
const KEEP_AFTER_COMPACTION = 30;

/** Reads project-level instructions (AGENTS.md / CLAUDE.md / AGENTOS.md) from the workspace, capped. */
export async function readProjectInstructions(workdir: string, cap = 8000): Promise<string | null> {
  for (const name of ["AGENTS.md", "CLAUDE.md", "AGENTOS.md"]) {
    try {
      const content = await fsp.readFile(path.join(workdir, name), "utf8");
      const trimmed = content.trim();
      if (trimmed) return trimmed.length > cap ? `${trimmed.slice(0, cap)}…[truncated]` : trimmed;
    } catch {
      // try the next convention
    }
  }
  return null;
}

/**
 * Keeps the model conversation bounded: when it grows past `max`, older turns are
 * replaced by an LLM summary (or a deterministic marker without a model), always
 * preserving the system message and whole assistant/tool pairs.
 */
export async function compactConversation(messages: Message[], model?: { complete: ModelProvider["complete"] } | null, signal?: AbortSignal): Promise<{ messages: Message[]; compacted: boolean; summary?: string }> {
  if (messages.length <= MAX_COMPACTION_MESSAGES) return { messages, compacted: false };
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const dropCount = rest.length - KEEP_AFTER_COMPACTION;
  // drop whole (assistant tool_calls + following tool results) units from the front
  let start = 0;
  let dropped = 0;
  while (dropped < dropCount && start < rest.length) {
    const m = rest[start];
    start++;
    dropped++;
    if (m.role === "assistant" && m.toolCalls?.length) {
      const ids = new Set(m.toolCalls.map((c) => c.id));
      while (start < rest.length && rest[start].role === "tool" && ids.has(rest[start].toolCallId ?? "")) {
        start++;
        dropped++;
      }
    }
  }
  const droppedMessages = rest.slice(0, start).filter((m) => !(m.role === "tool"));
  const source = droppedMessages.map((m) => `${m.role}${m.agent ? `(${m.agent})` : ""}: ${m.content.slice(0, 500)}`).join("\n").slice(0, 12_000);
  let summary = `[context compacted] ${dropped} earlier message(s) omitted.`;
  if (model && source.trim()) {
    try {
      const res = await model.complete(
        [
          { role: "system", content: "Summarise the following agent work log into at most 200 words. Focus on: goal, what was done (files touched, commands run), current state, what remains. Plain text only.", ts: nowIso() },
          { role: "user", content: source, ts: nowIso() },
        ],
        { maxTokens: 512, signal },
      );
      summary = `[context compacted] Earlier work summary: ${res.content.trim()}`;
    } catch {
      // summarisation is best-effort; the deterministic marker still bounds growth
    }
  }
  return { messages: [...system, { role: "user", content: summary, ts: nowIso() }, ...rest.slice(start)], compacted: true, summary };
}

export interface AgenticInput {
  /** Called after each executed tool call so the orchestrator can checkpoint. */
  onTurn: (result: StepResult) => Promise<void>;
  /** Researcher report from PLANNING; seeded into the conversation as context. */
  research?: ResearchReport | null;
}

export interface AgenticOutput {
  finalMessage: string;
  turns: number;
  toolCalls: number;
  results: StepResult[];
}

export class AgenticLoopAgent implements Agent<AgenticInput, AgenticOutput> {
  role: AgentRole = "executor";

  async run(ctx: AgentContext, input: AgenticInput): Promise<AgenticOutput> {
    if (!ctx.model?.completeWithTools) throw new AgentOSError("MODEL_REQUIRED", "mode=agentic requires a model provider with native tool calling (set LLM_API_KEY)");
    const { schemas, resolve } = toolSchemasFromRegistry(ctx.tools);
    if (schemas.length === 0) throw new AgentOSError("NO_TOOLS", "agentic mode requires at least one registered tool");
    const goal = ctx.task.spec.goal?.trim() || ctx.task.spec.title;
    const instructions = await readProjectInstructions(ctx.workdir);
    const maxTurnTokens = ctx.model.quirks?.maxTokens ?? 8192;
    // some providers / reverse proxies do not stream tool_calls deltas correctly —
    // quirks.toolStreaming=false falls back to non-streaming tool calling
    const toolStreaming = ctx.model.quirks?.toolStreaming !== false;
    const notes = new NotesStore(ctx.artifactsDir);
    const notesTail = await notes.read(2000);
    const skillsSection = skillsPromptSection(ctx.skills ?? []);
    // Aider-style workspace map: a structural index without reading every file
    let repoMap = "";
    try {
      const built = await buildRepoMap(ctx.workdir, { maxChars: 4000 });
      if (built.map) repoMap = `[workspace map] ${built.filesScanned} file(s), ${built.symbols} symbol(s):\n${built.map}`;
    } catch {
      // map is best-effort context, never a failure
    }
    const conversation: Message[] = [
      {
        role: "system",
        content: `${AGENTIC_SYSTEM}\n\nWorkspace: ${ctx.workdir}\nGoal: ${goal}${instructions ? `\n\nProject instructions (AGENTS.md):\n${instructions}` : ""}${skillsSection ? `\n\n${skillsSection}` : ""}${repoMap ? `\n\n${repoMap}` : ""}`,
        ts: nowIso(),
      },
    ];
    // transcript-level session resume: prior user/assistant turns seed the conversation
    // as real messages (not a summary block), so the model continues the dialogue
    for (const m of (ctx.task.spec.context ?? []).slice(-20)) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      conversation.push({ role: m.role, content: m.content.slice(0, 8000), ts: nowIso() });
    }
    if (input.research) {
      conversation.push({ role: "user", content: `[workspace research] ${JSON.stringify({ ...input.research, files: input.research.files.slice(0, 50) }).slice(0, 4000)}`, ts: nowIso() });
    }
    if (notesTail) {
      // E1: external memory survives conversation compaction
      conversation.push({ role: "user", content: `[external notes from earlier in this task] ${notesTail}`, ts: nowIso() });
    }
    // recovery: replay earlier observations so a resumed task keeps its context
    for (const m of ctx.checkpoint.messages.slice(-8)) {
      if (m.role === "system") continue;
      if (m.toolCalls?.length) continue;
      conversation.push(m.role === "tool" ? { role: "user", content: `[previous run observation] ${m.content.slice(0, 2000)}`, ts: m.ts } : { role: m.role, content: m.content.slice(0, 4000), ts: m.ts });
    }
    const results: StepResult[] = [];
    let turns = 0;
    let toolCalls = 0;
    let finalMessage = "";

    for (;;) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      turns++;
      let completion: ModelToolCompletion | null = null;
      // streaming path: text deltas fan out live as transient model.delta events
      if (toolStreaming && ctx.model.stream) {
        for await (const ev of ctx.model.stream(trimConversation(conversation), { tools: schemas, signal: ctx.signal, maxTokens: maxTurnTokens })) {
          if (ev.delta) {
            await ctx.bus.emit({ taskId: ctx.task.id, agentId: "executor", type: "model.delta", transient: true, data: { turn: turns, text: ev.delta } });
          }
          if (ev.completion) completion = ev.completion;
        }
        if (!completion) throw new AgentOSError("MODEL_EMPTY_RESPONSE", "model stream ended without a completion", { retryable: true });
      } else {
        completion = await ctx.model.completeWithTools(trimConversation(conversation), schemas, { signal: ctx.signal, maxTokens: maxTurnTokens });
      }
      ctx.budget.consumeTokens(completion.tokens);
      if (completion.finishReason === "length") {
        await ctx.bus.emit({ taskId: ctx.task.id, agentId: "executor", type: "model.truncated", data: { turn: turns, toolCalls: completion.toolCalls.length }, error: "model hit the completion token limit" });
      }
      await ctx.bus.emit({ taskId: ctx.task.id, agentId: "executor", type: "model.completed", data: { agent: "executor", tokens: completion.tokens, provider: ctx.model.name, turn: turns, toolCalls: completion.toolCalls.length, streamed: !!ctx.model.stream } });
      if (!completion.toolCalls.length) {
        finalMessage = completion.content.trim();
        pushMessage(ctx, "assistant", `agentic final (turn ${turns}): ${finalMessage.slice(0, 2000)}`, "executor");
        break;
      }
      conversation.push({ role: "assistant", content: completion.content, toolCalls: completion.toolCalls, ts: nowIso() });
      // Parallel execution of the turn's independent tool calls (Claude Code /
      // OpenAI parallel-function-calling style), bounded so a chatty turn cannot
      // spawn a process storm. Results are placed back in MODEL order so the
      // assistant tool_calls / tool result pairing stays intact for the provider.
      const limit = ctx.agentic?.parallelToolCalls === false ? 1 : Math.max(1, Math.min(ctx.agentic?.maxParallel ?? 4, 16));
      const ordered: { call: (typeof completion.toolCalls)[number]; result: StepResult }[] = new Array(completion.toolCalls.length);
      const workQueue = completion.toolCalls.map((call, index) => ({ call, index }));
      const executeCall = async (call: (typeof completion.toolCalls)[number]): Promise<StepResult> => {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        const started = Date.now();
        const target = resolve(call.name);
        let args: Record<string, unknown> = {};
        let parseError: string | undefined;
        // models emit malformed JSON arguments more often than anyone would like:
        // repair fences / smart quotes / trailing commas / unbalanced closers first
        for (const candidate of [call.arguments, repairToolArguments(call.arguments)]) {
          try {
            args = candidate.trim() ? (JSON.parse(candidate) as Record<string, unknown>) : {};
            parseError = undefined;
            break;
          } catch (err) {
            parseError = `invalid JSON arguments: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        if (!target || parseError) {
          const message = !target ? `unknown tool "${call.name}"` : parseError!;
          await ctx.bus.emit({ taskId: ctx.task.id, agentId: "executor", type: "agent.tool_call", tool: call.name, args: { turn: turns, invalid: true }, error: message });
          return { stepId: `t${turns}-${call.id}`, tool: call.name, action: "", ok: false, error: message, durationMs: Date.now() - started, attempt: 1, finishedAt: nowIso() };
        }
        ctx.budget.consumeToolCall();
        await ctx.bus.emit({ taskId: ctx.task.id, agentId: "executor", type: "agent.tool_call", tool: target.tool, args: { stepId: result_stepId(turns, call.id), action: target.action, turn: turns, arguments: args }, data: { source: "agentic" } });
        const output = await ctx.tools.execute(
          target.tool,
          { action: target.action, args },
          { taskId: ctx.task.id, agentId: "executor", workdir: ctx.workdir, signal: ctx.signal, timeoutMs: Math.min(ctx.budget.remainingMs() || 1, 10 * 60_000), bus: ctx.bus, shell: ctx.shell },
        );
        return {
          stepId: result_stepId(turns, call.id),
          tool: target.tool,
          action: target.action,
          ok: output.ok,
          output,
          error: output.ok ? undefined : `${output.error?.code}: ${output.error?.message}`,
          durationMs: Date.now() - started,
          attempt: 1,
          finishedAt: nowIso(),
        };
      };
      await Promise.all(
        Array.from({ length: Math.min(limit, workQueue.length) }, async () => {
          for (;;) {
            const next = workQueue.shift();
            if (!next) return;
            ordered[next.index] = { call: next.call, result: await executeCall(next.call) };
          }
        }),
      );
      for (const { call, result } of ordered) {
        results.push(result);
        if (result.ok) toolCalls++;
        conversation.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.ok ? summariseForModel(result.output!) : `ERROR: ${result.error}`, ts: nowIso() });
        pushMessage(ctx, "tool", `${result.stepId} ${result.tool}.${result.action} -> ${result.ok ? "ok" : `FAILED ${result.error}`}`, "executor");
        await notes.append(`${result.stepId} ${result.tool}.${result.action} -> ${result.ok ? "ok" : `FAILED ${String(result.error).slice(0, 120)}`}`);
        await input.onTurn(result);
      }
      // keep long agentic runs inside the context window
      const { messages: compacted, compacted: didCompact } = await compactConversation(conversation, ctx.model, ctx.signal);
      if (didCompact) {
        conversation.length = 0;
        conversation.push(...compacted);
        await ctx.bus.emit({ taskId: ctx.task.id, agentId: "executor", type: "model.context_compacted", data: { turn: turns, messages: conversation.length } });
      }
    }
    return { finalMessage, turns, toolCalls, results };
  }
}

function result_stepId(turn: number, callId: string): string {
  return `t${turn}-${callId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Tester
// ---------------------------------------------------------------------------

export class TesterAgent implements Agent<void, VerificationResult[]> {
  role: AgentRole = "tester";
  async run(ctx: AgentContext): Promise<VerificationResult[]> {
    const specs = ctx.task.spec.verification ?? [];
    const results: VerificationResult[] = [];
    // Verification commands are external operations too; account for each
    // one through BudgetGuard so maxToolCalls and the wall-clock budget apply
    // consistently to planner, executor, tester and reviewer work.
    for (const spec of specs) {
      ctx.budget.consumeToolCall();
      results.push(
        await ctx.verification.run(spec, {
          workdir: ctx.workdir,
          signal: ctx.signal,
          artifactsDir: ctx.artifactsDir,
          taskId: ctx.task.id,
          agentId: "tester",
          bus: ctx.bus,
          defaultTimeoutMs: Math.max(1000, Math.min(ctx.budget.remainingMs(), 10 * 60_000)),
          shell: ctx.shell,
        }),
      );
    }
    const acceptance = ctx.task.spec.acceptance ?? [];
    if (acceptance.length) {
      const checks: AcceptanceResult[] = [];
      for (const check of acceptance) {
        ctx.budget.consumeToolCall();
        const [result] = await ctx.verification.runAcceptance([check], { workdir: ctx.workdir, signal: ctx.signal });
        checks.push(result);
      }
      ctx.checkpoint.acceptance = checks;
      for (const result of checks) {
        await ctx.bus.emit({ taskId: ctx.task.id, agentId: "tester", type: result.passed ? "acceptance.passed" : "acceptance.failed", data: { check: result.check, detail: result.detail } });
      }
    } else {
      ctx.checkpoint.acceptance = [];
    }
    pushMessage(ctx, "tool", `verification: ${results.map((r) => `${r.name}=${r.passed ? "pass" : `fail(exit ${r.exitCode})`}`).join(", ") || "none configured"}`, "tester");
    return results;
  }
}

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

const SECRET_PROBE = /(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export class ReviewerAgent implements Agent<{ plan: Plan; stepResults: StepResult[]; verification: VerificationResult[]; acceptance?: AcceptanceResult[] }, ReviewResult> {
  role: AgentRole = "reviewer";

  async run(ctx: AgentContext, input: { plan: Plan; stepResults: StepResult[]; verification: VerificationResult[]; acceptance?: AcceptanceResult[] }): Promise<ReviewResult> {
    const issues: ReviewIssue[] = [];
    const checked: string[] = [];

    // 1. implementation — every planned step must have objective success evidence
    checked.push("implementation: every planned step has a successful result");
    const byId = new Map(input.stepResults.filter((r) => r.ok).map((r) => [r.stepId, r]));
    for (const s of input.plan.steps) {
      if (!byId.has(s.id)) issues.push({ category: "implementation", severity: "high", message: `step ${s.id} (${s.tool}.${s.action}) has no successful result`, stepId: s.id, fixable: true, fixSteps: [s] });
    }

    // 2. tests — verification must exist and pass
    checked.push("tests: configured verification passed");
    const failed = input.verification.filter((v) => !v.passed);
    for (const v of failed) {
      issues.push({ category: "tests", severity: "high", message: `verification "${v.name}" failed (exit ${v.exitCode}${v.timedOut ? ", timeout" : ""})`, fixable: input.plan.steps.some((s) => s.retryable) });
    }
    if (input.verification.length === 0 && (ctx.task.spec.acceptance ?? []).length === 0) {
      issues.push({ category: "tests", severity: "low", message: "no verification or acceptance checks configured; completion rests on step results only", fixable: false });
    }

    // 3. requirements — acceptance checks
    checked.push("requirements: acceptance checks");
    const acceptance = ctx.task.spec.acceptance ?? [];
    if (acceptance.length) {
      // Prefer the tester's checkpointed evidence.  The fallback keeps the
      // reviewer usable when called directly by an embedding application.
      let results = input.acceptance;
      if (!results) {
        results = [];
        for (const check of acceptance) {
          ctx.budget.consumeToolCall();
          const [result] = await ctx.verification.runAcceptance([check], { workdir: ctx.workdir, signal: ctx.signal });
          results.push(result);
        }
      }
      for (const r of results) {
        await ctx.bus.emit({ taskId: ctx.task.id, agentId: "reviewer", type: r.passed ? "review.check_passed" : "review.check_failed", data: { check: r.check, detail: r.detail } });
        if (!r.passed) issues.push({ category: "requirements", severity: "high", message: `acceptance failed: ${r.check.description ?? r.check.type} — ${r.detail}`, fixable: false });
      }
    }

    // 4. security — secrets in written content / commands, privilege escalation
    checked.push("security: secrets in written content, sudo usage, protected paths");
    for (const s of input.plan.steps) {
      const content = typeof s.args.content === "string" ? s.args.content : typeof s.args.command === "string" ? s.args.command : "";
      if (content && (SECRET_PROBE.test(content) || redactString(content) !== content)) {
        issues.push({ category: "security", severity: "high", message: `step ${s.id} embeds what looks like a secret`, stepId: s.id, fixable: false });
      }
      if (typeof s.args.command === "string" && /\bsudo\b/.test(s.args.command)) {
        issues.push({ category: "security", severity: "medium", message: `step ${s.id} uses sudo`, stepId: s.id, fixable: false });
      }
      const p = typeof s.args.path === "string" ? s.args.path : "";
      if (/(^|\/)(node_modules|\.git)(\/|$)/.test(p)) {
        issues.push({ category: "architecture", severity: "high", message: `step ${s.id} writes into protected path ${p}`, stepId: s.id, fixable: false });
      }
    }

    // 5. edge cases — truncated outputs / non-idempotent appends without verification
    checked.push("edge_cases: truncated tool output, retried steps");
    for (const r of input.stepResults) {
      if (r.output?.truncated) issues.push({ category: "edge_cases", severity: "low", message: `step ${r.stepId} produced truncated output`, stepId: r.stepId, fixable: false });
      if (r.attempt > 1) issues.push({ category: "edge_cases", severity: "low", message: `step ${r.stepId} needed ${r.attempt} attempts`, stepId: r.stepId, fixable: false });
    }

    // 6. regressions — if workspace is a git repo, report uncommitted changes count for audit
    checked.push("regressions: git working tree inspected");
    const git = await getGitState(ctx.workdir, ctx.signal);
    if (git.isRepo) {
      const status = await runGit(["status", "--porcelain"], { cwd: ctx.workdir, signal: ctx.signal });
      const changed = status.stdout.split("\n").filter(Boolean);
      await ctx.bus.emit({ taskId: ctx.task.id, agentId: "reviewer", type: "review.git_state", data: { branch: git.branch, head: git.head, changedFiles: changed.slice(0, 100) } });
      const regressionSpecs = input.verification.filter((v) => ["unit", "integration", "e2e"].includes(v.kind));
      if (changed.length > 0 && regressionSpecs.length === 0 && input.plan.steps.some((s) => s.tool === "filesystem" && ["write", "edit", "delete", "move"].includes(s.action))) {
        issues.push({ category: "regressions", severity: "low", message: `${changed.length} file(s) changed without a regression test suite in verification`, fixable: false });
      }
    }

    // 7. optional model review
    if (ctx.model) {
      checked.push("model: independent LLM review");
      try {
        const raw = await askModel(
          ctx,
          "reviewer",
          `You are an independent code reviewer. Return JSON {"issues":[{"category":"requirements|implementation|tests|security|edge_cases|architecture|regressions","severity":"low|medium|high","message":string}]}. Be strict; do not trust the executor's claims.`,
          `Goal: ${ctx.task.spec.goal}\nPlan: ${JSON.stringify(input.plan.steps).slice(0, 4000)}\nResults: ${JSON.stringify(input.stepResults.map((r) => ({ id: r.stepId, ok: r.ok, error: r.error }))).slice(0, 3000)}\nVerification: ${JSON.stringify(input.verification.map((v) => ({ name: v.name, passed: v.passed, exitCode: v.exitCode, stderr: v.stderr.slice(0, 500) })))}`,
        );
        const json = extractJson<{ issues?: ReviewIssue[] }>(raw);
        for (const i of json.issues ?? []) issues.push({ ...i, fixable: false });
      } catch (err) {
        issues.push({ category: "tests", severity: "low", message: `model review unavailable: ${err instanceof Error ? err.message : String(err)}`, fixable: false });
      }
    }

    const verdict: ReviewResult["verdict"] = issues.some((i) => i.severity === "high") ? "FAIL" : issues.some((i) => i.severity === "medium") ? "NEEDS_IMPROVEMENT" : "PASS";
    const review: ReviewResult = { verdict, issues, checked, reviewedAt: nowIso() };
    pushMessage(ctx, "assistant", `review: ${verdict} (${issues.length} issues)`, "reviewer");
    await ctx.bus.emit({ taskId: ctx.task.id, agentId: "reviewer", type: "review.completed", data: { verdict, issues: issues.map((i) => `${i.severity}/${i.category}: ${i.message}`) } });
    return review;
  }
}

// ---------------------------------------------------------------------------
// Debugger
// ---------------------------------------------------------------------------

export type Failure =
  | { kind: "step"; step: StepSpec; result: StepResult }
  | { kind: "verification"; results: VerificationResult[] }
  | { kind: "acceptance"; results: AcceptanceResult[] }
  | { kind: "review"; review: ReviewResult }
  | { kind: "error"; error: unknown };

const TRANSIENT_CODES = new Set(["TIMEOUT", "BUSY", "NETWORK_ERROR", "EAGAIN", "EBUSY", "ETIMEDOUT", "ECONNRESET", "TOO_MANY_PROCESSES", "MODEL_ERROR", "MODEL_HTTP_ERROR"]);
const FATAL_CODES = new Set(["BUDGET_EXCEEDED", "DANGEROUS_COMMAND", "PATH_TRAVERSAL", "BLOCKED_HOST", "PLAN_INVALID", "PLAN_UNAVAILABLE", "PLAN_EMPTY", "UNKNOWN_TOOL", "UNKNOWN_ACTION", "MISSING_ARGUMENT", "INVALID_ARGUMENT", "INVALID_PATH", "INVALID_COMMAND", "HOOK_BLOCKED", "MODEL_REQUIRED", "PERMISSION_DENIED"]);

export class DebuggerAgent implements Agent<Failure, Diagnosis> {
  role: AgentRole = "debugger";

  async run(ctx: AgentContext, failure: Failure): Promise<Diagnosis> {
    const attemptsSummary = ctx.checkpoint.messages
      .filter((m) => m.role === "tool" || m.agent === "debugger")
      .slice(-10)
      .map((m) => `[${m.ts}] ${m.agent ?? m.role}: ${m.content.slice(0, 200)}`);
    let d: Diagnosis;
    switch (failure.kind) {
      case "step": {
        const code = failure.result.output?.error?.code ?? "";
        if (FATAL_CODES.has(code)) {
          d = { rootCause: `step ${failure.step.id} failed with non-recoverable error ${code}: ${failure.result.error}`, category: "plan", retryable: false, attemptsSummary, recommendedNextAction: "fix the task specification (invalid tool arguments, blocked command or path)" };
        } else if (TRANSIENT_CODES.has(code) || failure.result.output?.error?.retryable) {
          d = { rootCause: `transient failure in step ${failure.step.id}: ${failure.result.error}`, category: "transient", retryable: true, suggestedSteps: [failure.step], attemptsSummary, recommendedNextAction: "re-run the failed step" };
        } else if (failure.step.retryable) {
          d = { rootCause: `step ${failure.step.id} failed: ${failure.result.error}`, category: "tool_error", retryable: true, suggestedSteps: [failure.step], attemptsSummary, recommendedNextAction: "re-run the retryable step" };
        } else {
          d = { rootCause: `step ${failure.step.id} failed: ${failure.result.error}`, category: "tool_error", retryable: false, attemptsSummary, recommendedNextAction: "inspect the step arguments and the tool error; the step is not marked retryable" };
        }
        break;
      }
      case "verification": {
        const failed = failure.results.filter((r) => !r.passed);
        const retryableSteps = (ctx.checkpoint.plan?.steps ?? []).filter((s) => s.retryable);
        if (failed.some((f) => f.timedOut)) {
          d = { rootCause: `verification timed out: ${failed.map((f) => f.name).join(", ")}`, category: "transient", retryable: true, attemptsSummary, recommendedNextAction: "re-run verification" };
        } else if (retryableSteps.length) {
          d = { rootCause: `verification failed: ${failed.map((f) => `${f.name} exit=${f.exitCode}`).join(", ")}`, category: "verification", retryable: true, suggestedSteps: retryableSteps, attemptsSummary, recommendedNextAction: "re-run retryable steps then verify again" };
        } else {
          d = { rootCause: `verification failed: ${failed.map((f) => `${f.name} exit=${f.exitCode} ${f.stderr.slice(0, 200)}`).join("; ")}`, category: "verification", retryable: false, attemptsSummary, recommendedNextAction: "the implementation does not satisfy the verification commands; no retryable steps available" };
        }
        break;
      }
      case "acceptance": {
        const failed = failure.results.filter((r) => !r.passed);
        const retryableSteps = (ctx.checkpoint.plan?.steps ?? []).filter((s) => s.retryable);
        d = {
          rootCause: `acceptance failed: ${failed.map((r) => `${r.check.description ?? r.check.type}: ${r.detail}`).join("; ")}`,
          category: "verification",
          retryable: retryableSteps.length > 0,
          suggestedSteps: retryableSteps.length ? retryableSteps : undefined,
          attemptsSummary,
          recommendedNextAction: retryableSteps.length ? "re-run retryable steps then evaluate acceptance checks" : "address the failed acceptance checks",
        };
        break;
      }
      case "review": {
        const fixSteps = failure.review.issues.flatMap((i) => i.fixSteps ?? []);
        d = {
          rootCause: `reviewer verdict ${failure.review.verdict}: ${failure.review.issues.filter((i) => i.severity !== "low").map((i) => i.message).join("; ")}`,
          category: "review",
          retryable: fixSteps.length > 0,
          suggestedSteps: fixSteps.length ? fixSteps : undefined,
          attemptsSummary,
          recommendedNextAction: fixSteps.length ? "execute reviewer fix steps" : "address reviewer issues in the task specification",
        };
        break;
      }
      default: {
        const err = failure.error as AgentOSError;
        const code = err?.code ?? "";
        d = {
          rootCause: `${code || "error"}: ${err instanceof Error ? err.message : String(failure.error)}`,
          category: code === "BUDGET_EXCEEDED" ? "budget" : TRANSIENT_CODES.has(code) ? "transient" : "unknown",
          retryable: TRANSIENT_CODES.has(code) || (!!err?.retryable && !FATAL_CODES.has(code)),
          attemptsSummary,
          recommendedNextAction: code === "BUDGET_EXCEEDED" ? "increase the budget or reduce the plan" : "inspect the error and the event log",
        };
      }
    }
    if (ctx.model && !d.retryable && failure.kind !== "error") {
      try {
        const raw = await askModel(ctx, "debugger", `You are the Debugger. Given a failure, return JSON {"rootCause": string, "steps": [{"id":string,"tool":string,"action":string,"args":object}]} with concrete fix steps using only known tools, or an empty steps array if unfixable.`, JSON.stringify({ failure: summariseFailure(failure), tools: ctx.tools.list().map((t) => ({ name: t.name, actions: t.actions.map((a) => a.name) })) }).slice(0, 6000));
        const json = extractJson<{ rootCause?: string; steps?: StepSpec[] }>(raw);
        if (json.steps?.length) {
          const plan: Plan = { steps: json.steps.map((s, i) => ({ ...s, id: s.id || `fix-${i + 1}`, args: s.args ?? {} })), rationale: "", source: "model" };
          validatePlan(plan, ctx.tools);
          d = { ...d, rootCause: json.rootCause ?? d.rootCause, retryable: true, suggestedSteps: plan.steps, recommendedNextAction: "apply model-suggested fix steps" };
        }
      } catch {
        // fall back to heuristic diagnosis
      }
    }
    pushMessage(ctx, "assistant", `diagnosis: ${d.category} retryable=${d.retryable} ${d.rootCause}`, "debugger");
    await ctx.bus.emit({ taskId: ctx.task.id, agentId: "debugger", type: "task.diagnosed", data: { category: d.category, retryable: d.retryable, rootCause: d.rootCause } });
    return d;
  }
}

function summariseFailure(f: Failure): unknown {
  switch (f.kind) {
    case "step":
      return { kind: f.kind, step: f.step, error: f.result.error };
    case "verification":
      return { kind: f.kind, failed: f.results.filter((r) => !r.passed).map((r) => ({ name: r.name, exitCode: r.exitCode, stderr: r.stderr.slice(0, 1500), stdout: r.stdout.slice(-1500) })) };
    case "acceptance":
      return { kind: f.kind, failed: f.results.filter((r) => !r.passed).map((r) => ({ check: r.check, detail: r.detail })) };
    case "review":
      return { kind: f.kind, issues: f.review.issues };
    default:
      return { kind: f.kind, error: f.error instanceof Error ? f.error.message : String(f.error) };
  }
}

// ---------------------------------------------------------------------------
// Integrator — merges isolated worktree branches back, with rollback on conflict
// ---------------------------------------------------------------------------

export interface IntegrateInput {
  worktree: { path: string; branch: string; baseBranch: string };
  message: string;
}

export class IntegratorAgent implements Agent<IntegrateInput, { merged: boolean; head?: string; conflicts?: unknown; rolledBack: boolean }> {
  role: AgentRole = "integrator";

  async run(ctx: AgentContext, input: IntegrateInput) {
    const root = ctx.task.workdir; // the main repository, not the worktree
    const wt = input.worktree;
    // commit whatever the executor produced inside the worktree
    await runGit(["add", "-A"], { cwd: wt.path, signal: ctx.signal });
    const commit = await runGit(["commit", "-q", "-m", input.message, "--no-verify"], { cwd: wt.path, signal: ctx.signal });
    const nothing = /nothing to commit/.test(commit.stdout + commit.stderr);
    if (commit.exitCode !== 0 && !nothing) throw new AgentOSError("INTEGRATION_COMMIT_FAILED", commit.stderr.trim());
    ctx.budget.usage.toolCalls += 2;
    await ctx.bus.emit({ taskId: ctx.task.id, agentId: "integrator", type: "integrator.committed", data: { branch: wt.branch, nothingToCommit: nothing } });
    if (nothing) {
      await cleanupWorktree(root, wt, ctx.signal);
      return { merged: true, rolledBack: false };
    }
    const merge = await ctx.tools.execute("git", { action: "merge", args: { branch: wt.branch, message: input.message } }, { taskId: ctx.task.id, agentId: "integrator", workdir: root, signal: ctx.signal, bus: ctx.bus, shell: ctx.shell });
    ctx.budget.usage.toolCalls += 1;
    if (!merge.ok) {
      // git tool already aborted the merge; remove the worktree but keep the branch for inspection
      await runGit(["worktree", "remove", "--force", wt.path], { cwd: root, signal: ctx.signal });
      await ctx.bus.emit({ taskId: ctx.task.id, agentId: "integrator", type: "integrator.conflict", error: merge.error?.message, data: { branch: wt.branch, details: merge.error?.details } });
      return { merged: false, conflicts: merge.error?.details, rolledBack: true };
    }
    await cleanupWorktree(root, wt, ctx.signal);
    await ctx.bus.emit({ taskId: ctx.task.id, agentId: "integrator", type: "integrator.merged", data: { branch: wt.branch, head: (merge.data as { head: string }).head } });
    return { merged: true, head: (merge.data as { head: string }).head, rolledBack: false };
  }
}

async function cleanupWorktree(root: string, wt: { path: string; branch: string }, signal: AbortSignal) {
  await runGit(["worktree", "remove", "--force", wt.path], { cwd: root, signal });
  await runGit(["branch", "-D", wt.branch], { cwd: root, signal });
}

export const AGENT_CATALOG: { role: AgentRole; description: string }[] = [
  { role: "planner", description: "Turns a task spec/goal into a validated, executable step plan (spec → DSL → model)" },
  { role: "researcher", description: "Inspects the workspace: files, package scripts, git state, suggested verification" },
  { role: "executor", description: "Runs plan steps through the tool runtime with budgets, retries and checkpoints" },
  { role: "tester", description: "Runs the verification engine (tests/lint/typecheck/build/custom) and records evidence" },
  { role: "reviewer", description: "Independent review: requirements, implementation, tests, security, edge cases, architecture, regressions" },
  { role: "debugger", description: "Diagnoses failures, classifies root cause, proposes fix steps or declares the failure terminal" },
  { role: "integrator", description: "Commits isolated worktree results and merges them back; rolls back on conflict" },
];
