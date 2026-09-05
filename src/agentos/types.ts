// AgentOS core types — shared by runtime, tools, agents, CLI and dashboard.

export type TaskStatus =
  | "CREATED"
  | "QUEUED"
  | "PLANNING"
  | "EXECUTING"
  | "VERIFYING"
  | "FIXING"
  | "REVIEWING"
  | "DIAGNOSING"
  | "RETRYING"
  | "COMPLETED"
  | "FAILED"
  | "PAUSED"
  | "CANCELLED"
  | "BLOCKED";

export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  "PLANNING",
  "EXECUTING",
  "VERIFYING",
  "FIXING",
  "REVIEWING",
  "DIAGNOSING",
  "RETRYING",
];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

export type AgentRole =
  | "planner"
  | "executor"
  | "tester"
  | "reviewer"
  | "debugger"
  | "researcher"
  | "integrator";

export const AGENT_ROLES: readonly AgentRole[] = [
  "planner",
  "researcher",
  "executor",
  "tester",
  "reviewer",
  "debugger",
  "integrator",
];

export interface Budget {
  maxRetries: number;
  timeoutMs: number;
  maxToolCalls: number;
  maxTokens: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxRetries: 2,
  timeoutMs: 10 * 60 * 1000,
  maxToolCalls: 200,
  maxTokens: 200_000,
};

export interface StepExpectation {
  exitCode?: number;
  stdoutIncludes?: string;
  ok?: boolean;
}

export interface StepSpec {
  id: string;
  tool: string;
  action: string;
  args: Record<string, unknown>;
  description?: string;
  expect?: StepExpectation;
  retryable?: boolean;
  timeoutMs?: number;
}

export type VerificationKind = "unit" | "integration" | "e2e" | "lint" | "typecheck" | "build" | "custom";

export interface VerificationSpec {
  name: string;
  kind: VerificationKind;
  /** Optional for preset kinds; the engine derives a package-manager command. */
  command?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface AcceptanceCheck {
  type: "file_exists" | "file_contains" | "file_not_contains" | "command_succeeds";
  path?: string;
  text?: string;
  command?: string;
  description?: string;
}

export interface TaskSpec {
  title: string;
  goal: string;
  priority?: number;
  dependsOn?: string[];
  steps?: StepSpec[];
  verification?: VerificationSpec[];
  acceptance?: AcceptanceCheck[];
  budget?: Partial<Budget>;
  workdir?: string;
  tags?: string[];
  /** When true the executor runs inside an isolated git worktree and the integrator merges it back. */
  isolated?: boolean;
  /**
   * Execution mode. `plan` (default) derives a static step plan and runs it deterministically.
   * `agentic` lets an LLM drive the tool registry in a loop (Claude Code / Codex style);
   * verification and the independent reviewer still gate completion with objective evidence.
   */
  mode?: ExecutionMode;
}

export type ExecutionMode = "plan" | "agentic";

export interface TaskUsage {
  toolCalls: number;
  tokens: number;
  retries: number;
  fixes: number;
  elapsedMs: number;
}

export interface Task {
  id: string;
  spec: TaskSpec;
  status: TaskStatus;
  priority: number;
  dependsOn: string[];
  budget: Budget;
  usage: TaskUsage;
  attempt: number;
  workdir: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: TaskResult;
  error?: string;
}

export interface Plan {
  steps: StepSpec[];
  rationale: string;
  source: "spec" | "heuristic" | "model";
}

export interface TaskResult {
  plan?: Plan;
  stepResults: StepResult[];
  verification: VerificationResult[];
  /** Declarative acceptance evidence evaluated after verification. */
  acceptance?: AcceptanceResult[];
  review?: ReviewResult;
  diagnosis?: Diagnosis;
  summary: string;
}

// ---- Tools -------------------------------------------------------------

export interface ToolInput {
  action: string;
  args: Record<string, unknown>;
}

export interface ToolErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface ToolOutput {
  ok: boolean;
  tool: string;
  action: string;
  data?: unknown;
  error?: ToolErrorInfo;
  durationMs: number;
  truncated?: boolean;
}

export interface ToolContext {
  taskId: string;
  agentId: string;
  workdir: string;
  signal: AbortSignal;
  timeoutMs: number;
  env: Record<string, string>;
  /** Optional shell override (for example `pwsh`, `cmd.exe`, or a Bash path). */
  shell?: string;
  log: (message: string) => void;
}

export interface ToolActionDef {
  name: string;
  description: string;
  params: Record<string, string>;
}

export interface Tool {
  name: string;
  description: string;
  actions: ToolActionDef[];
  execute(input: ToolInput, ctx: ToolContext): Promise<unknown>;
}

export interface StepResult {
  stepId: string;
  tool: string;
  action: string;
  ok: boolean;
  output?: ToolOutput;
  error?: string;
  durationMs: number;
  attempt: number;
  finishedAt: string;
}

// ---- Events ------------------------------------------------------------

export interface AgentEvent {
  id?: number;
  seq: number;
  ts: string;
  taskId: string | null;
  agentId: string | null;
  type: string;
  tool?: string | null;
  args?: unknown;
  result?: unknown;
  durationMs?: number | null;
  error?: string | null;
  data?: Record<string, unknown>;
}

export type EventInput = Omit<AgentEvent, "seq" | "ts" | "id"> & { ts?: string };

export interface EventFilter {
  taskId?: string;
  agentId?: string;
  type?: string;
  typePrefix?: string;
  afterId?: number;
  limit?: number;
}

// ---- Checkpoints / recovery -------------------------------------------

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  ts: string;
  agent?: AgentRole;
  /** Assistant message: tool invocations requested by the model (agentic loop). */
  toolCalls?: ToolCallRequest[];
  /** Tool message: id of the tool call this result answers. */
  toolCallId?: string;
  /** Tool message: registry name of the tool that produced the result. */
  name?: string;
}

export interface GitState {
  isRepo: boolean;
  branch?: string;
  head?: string;
  dirty?: boolean;
}

export interface Checkpoint {
  taskId: string;
  version: number;
  phase: TaskStatus;
  attempt: number;
  plan?: Plan;
  completedSteps: StepResult[];
  pendingFixSteps?: StepSpec[];
  messages: Message[];
  verification: VerificationResult[];
  acceptance?: AcceptanceResult[];
  review?: ReviewResult;
  diagnosis?: Diagnosis;
  workdir: string;
  worktree?: { path: string; branch: string; baseBranch: string };
  git?: GitState;
  usage: TaskUsage;
  progress: number;
  savedAt: string;
}

// ---- Verification -----------------------------------------------------

export interface VerificationResult {
  name: string;
  kind: VerificationKind;
  command: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  artifacts: string[];
  timedOut: boolean;
}

export interface AcceptanceResult {
  check: AcceptanceCheck;
  passed: boolean;
  detail: string;
}

// ---- Review / diagnosis -----------------------------------------------

export type ReviewVerdict = "PASS" | "FAIL" | "NEEDS_IMPROVEMENT";

export type ReviewCategory =
  | "requirements"
  | "implementation"
  | "tests"
  | "security"
  | "edge_cases"
  | "architecture"
  | "regressions";

export interface ReviewIssue {
  category: ReviewCategory;
  severity: "low" | "medium" | "high";
  message: string;
  stepId?: string;
  fixable: boolean;
  fixSteps?: StepSpec[];
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  issues: ReviewIssue[];
  checked: string[];
  reviewedAt: string;
}

export interface Diagnosis {
  rootCause: string;
  category: "transient" | "tool_error" | "verification" | "review" | "budget" | "plan" | "unknown";
  retryable: boolean;
  suggestedSteps?: StepSpec[];
  attemptsSummary: string[];
  recommendedNextAction: string;
}

// ---- Model provider ---------------------------------------------------

export interface ModelCompletion {
  content: string;
  tokens: number;
}

/** A tool invocation requested by the model. `arguments` is the raw JSON string from the provider. */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

/** JSON-schema description of a tool handed to the model (OpenAI function-calling format). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCompletion {
  content: string;
  toolCalls: ToolCallRequest[];
  tokens: number;
  finishReason?: string;
}

/** Incremental chunk of a streamed model response. */
export interface ModelStreamEvent {
  /** Text delta (may be empty while the model emits tool calls). */
  delta?: string;
  /** Set on the final event, mirroring the non-streaming completion. */
  completion?: ModelToolCompletion;
}

export interface ModelProvider {
  name: string;
  complete(messages: Message[], opts?: { json?: boolean; maxTokens?: number; signal?: AbortSignal }): Promise<ModelCompletion>;
  /**
   * Native tool-calling completion (OpenAI-compatible `tools` / `tool_calls`).
   * Optional: harnesses fall back to JSON-mode `complete()` when absent.
   */
  completeWithTools?(messages: Message[], tools: ToolSchema[], opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<ModelToolCompletion>;
  /** Optional SSE streaming; yields text deltas and a final completion. */
  stream?(messages: Message[], opts?: { maxTokens?: number; signal?: AbortSignal }): AsyncIterable<ModelStreamEvent>;
}

// ---- Errors -----------------------------------------------------------

export class AgentOSError extends Error {
  code: string;
  retryable: boolean;
  details?: unknown;
  constructor(code: string, message: string, opts: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "AgentOSError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

export class ToolError extends AgentOSError {
  constructor(code: string, message: string, opts: { retryable?: boolean; details?: unknown } = {}) {
    super(code, message, opts);
    this.name = "ToolError";
  }
}

export class BudgetExceededError extends AgentOSError {
  constructor(kind: string, limit: number, actual: number) {
    super("BUDGET_EXCEEDED", `${kind} budget exceeded: ${actual} > ${limit}`, { details: { kind, limit, actual } });
    this.name = "BudgetExceededError";
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && (err.name === "AbortError" || err.message === "pause" || err.message === "cancel")) ||
    err === "pause" ||
    err === "cancel"
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
