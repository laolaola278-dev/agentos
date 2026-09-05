import path from "node:path";
import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Checkpoint, ModelProvider, Task, TaskSpec, TaskStatus } from "./types";
import { ACTIVE_STATUSES, AgentOSError, DEFAULT_BUDGET, TERMINAL_STATUSES, nowIso } from "./types";
import { FilePersistence, MemoryPersistence, SqlitePersistence, type Persistence } from "./persistence";
import { EventBus } from "./events";
import { createDefaultToolRegistry, ProcessManager, ToolRegistry } from "./tools";
import { VerificationEngine } from "./verification";
import { TaskQueue } from "./queue";
import { Orchestrator } from "./orchestrator";
import { MetricsCollector } from "./metrics";
import { AGENT_CATALOG } from "./agents";
import { getGitState } from "./tools/git";
import { resolveSafePath } from "./security";
import { loadAgentOsConfig, type AgentOsConfig } from "./config";
import { HookRunner } from "./hooks";
import { registerMcpTools, type McpClient, type McpRegistration } from "./mcp";
import type { PermissionMode, PermissionRequest } from "./types";
import { loadVault, type SecretVault } from "./secrets";
import { normalizeSandboxConfig, type SandboxConfig } from "./sandbox";
import { resolveProviderSettings, createProviderFromSettings, type ResolvedProviderSettings } from "./providers";

export type PersistenceKind = "memory" | "file" | "sqlite";

export interface RuntimeOptions {
  rootDir?: string;
  dataDir?: string;
  persistence?: Persistence | PersistenceKind;
  concurrency?: number;
  model?: ModelProvider | null;
  jsonlMirror?: boolean;
  controlPollMs?: number;
  allowDangerousCommands?: boolean;
  tools?: ToolRegistry;
  heartbeatMs?: number;
  defaultBudget?: Partial<typeof DEFAULT_BUDGET>;
  /** Shell executable for terminal and verification commands (or env default). */
  shell?: string;
  /**
   * Harness config (hooks, MCP servers). `undefined` loads `<dataDir>/config.json` when present,
   * `null` disables config loading entirely.
   */
  config?: AgentOsConfig | null;
  /** "confirm" requires `onPermissionRequest` approval before every tool execution (interactive sessions). */
  permissionMode?: PermissionMode;
  /** Async approval callback used when `permissionMode: "confirm"`. */
  onPermissionRequest?: (req: PermissionRequest) => Promise<boolean>;
  /** Sandbox tier for shell commands. `undefined` resolves from config/env, `false` disables. */
  sandbox?: SandboxConfig | false;
  /** Secret vault. `undefined` loads `<dataDir>/secrets.json` when present; `false`/`null` disable. */
  secrets?: SecretVault | null | false;
}

interface RunningEntry {
  controller: AbortController;
  promise: Promise<Task>;
}

export interface DoctorReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

const MAX_TITLE_LENGTH = 300;
const MAX_GOAL_LENGTH = 256 * 1024;
const MAX_TAGS = 64;

/** Validate and normalise user/API task input before it enters the queue. */
export function normalizeTaskSpec(input: TaskSpec, rootDir: string, defaultBudget: typeof DEFAULT_BUDGET = DEFAULT_BUDGET): TaskSpec {
  if (!input || typeof input !== "object") throw new AgentOSError("INVALID_SPEC", "task spec must be an object");
  if (typeof input.title !== "string" || !input.title.trim()) throw new AgentOSError("INVALID_SPEC", "task title is required");
  if (input.title.length > MAX_TITLE_LENGTH) throw new AgentOSError("INVALID_SPEC", `task title exceeds ${MAX_TITLE_LENGTH} characters`);
  if (typeof input.goal !== "string") throw new AgentOSError("INVALID_SPEC", "task goal is required");
  if (input.goal.length > MAX_GOAL_LENGTH) throw new AgentOSError("INVALID_SPEC", `task goal exceeds ${MAX_GOAL_LENGTH} characters`);
  if (input.priority !== undefined && (!Number.isFinite(input.priority) || Math.abs(Number(input.priority)) > 1_000_000)) throw new AgentOSError("INVALID_SPEC", "priority must be a finite number between -1000000 and 1000000");

  let workdir: string;
  try {
    workdir = resolveSafePath(rootDir, input.workdir ?? ".");
  } catch (err) {
    throw new AgentOSError("INVALID_SPEC", `workdir is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (input.dependsOn !== undefined && !Array.isArray(input.dependsOn)) throw new AgentOSError("INVALID_SPEC", "dependsOn must be an array");
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  if (dependsOn.some((d) => typeof d !== "string" || !d.trim())) throw new AgentOSError("INVALID_SPEC", "dependsOn must contain non-empty task ids");
  if (dependsOn.length > 1000) throw new AgentOSError("INVALID_SPEC", "too many task dependencies (max 1000)");

  if (input.budget !== undefined && (typeof input.budget !== "object" || input.budget === null || Array.isArray(input.budget))) throw new AgentOSError("INVALID_SPEC", "budget must be an object");
  const budget = { ...defaultBudget, ...(input.budget ?? {}) };
  const integer = (name: string, value: number, min: number, max: number) => {
    if (!Number.isInteger(value) || value < min || value > max) throw new AgentOSError("INVALID_SPEC", `${name} must be an integer between ${min} and ${max}`);
  };
  integer("maxRetries", budget.maxRetries, 0, 100);
  integer("timeoutMs", budget.timeoutMs, 1, 24 * 60 * 60 * 1000);
  integer("maxToolCalls", budget.maxToolCalls, 1, 1_000_000);
  integer("maxTokens", budget.maxTokens, 0, 100_000_000);

  if (input.steps !== undefined && (!Array.isArray(input.steps) || input.steps.length > 500)) throw new AgentOSError("INVALID_SPEC", "steps must be an array of at most 500 items");
  if (input.verification !== undefined && (!Array.isArray(input.verification) || input.verification.length > 200)) throw new AgentOSError("INVALID_SPEC", "verification must be an array of at most 200 items");
  if (input.acceptance !== undefined && (!Array.isArray(input.acceptance) || input.acceptance.length > 500)) throw new AgentOSError("INVALID_SPEC", "acceptance must be an array of at most 500 items");
  const validKinds = new Set(["unit", "integration", "e2e", "lint", "typecheck", "build", "custom"]);
  for (const [index, verification] of (input.verification ?? []).entries()) {
    if (!verification || typeof verification !== "object" || typeof verification.name !== "string" || !verification.name.trim()) throw new AgentOSError("INVALID_SPEC", `verification[${index}] requires a name`);
    if (!validKinds.has(verification.kind) || (verification.command !== undefined && (typeof verification.command !== "string" || verification.command.length > 64 * 1024))) throw new AgentOSError("INVALID_SPEC", `verification[${index}] has an invalid kind or command`);
  }
  for (const [index, check] of (input.acceptance ?? []).entries()) {
    if (!check || typeof check !== "object" || !["file_exists", "file_contains", "file_not_contains", "command_succeeds"].includes(check.type)) throw new AgentOSError("INVALID_SPEC", `acceptance[${index}] has an invalid type`);
    if (["file_exists", "file_contains", "file_not_contains"].includes(check.type) && (typeof check.path !== "string" || !check.path)) throw new AgentOSError("INVALID_SPEC", `acceptance[${index}] requires a path`);
    if (["file_contains", "file_not_contains"].includes(check.type) && typeof check.text !== "string") throw new AgentOSError("INVALID_SPEC", `acceptance[${index}] requires text`);
    if (check.type === "command_succeeds" && (typeof check.command !== "string" || !check.command.trim())) throw new AgentOSError("INVALID_SPEC", `acceptance[${index}] requires a command`);
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) throw new AgentOSError("INVALID_SPEC", "tags must be an array");
  const tags = input.tags === undefined ? undefined : [...new Set(input.tags.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim()))];
  if (tags && tags.length > MAX_TAGS) throw new AgentOSError("INVALID_SPEC", `too many tags (max ${MAX_TAGS})`);
  if (input.mode !== undefined && input.mode !== "plan" && input.mode !== "agentic") throw new AgentOSError("INVALID_SPEC", 'mode must be "plan" or "agentic"');

  return {
    ...structuredClone(input),
    title: input.title.trim(),
    goal: input.goal,
    workdir,
    dependsOn,
    budget,
    tags,
  };
}

/** Keeps `.agentos/` out of `git status` without editing the user's .gitignore (uses .git/info/exclude). */
async function excludeDataDirFromGit(rootDir: string, dataDir: string): Promise<void> {
  const rel = path.relative(rootDir, dataDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  const gitDir = path.join(rootDir, ".git");
  try {
    if (!(await fsp.stat(gitDir)).isDirectory()) return;
  } catch {
    return;
  }
  const excludeFile = path.join(gitDir, "info", "exclude");
  const line = `/${rel.split(path.sep).join("/")}/`;
  try {
    const existing = await fsp.readFile(excludeFile, "utf8").catch(() => "");
    if (existing.split("\n").some((l) => l.trim() === line)) return;
    await fsp.mkdir(path.dirname(excludeFile), { recursive: true });
    await fsp.appendFile(excludeFile, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${line}\n`);
  } catch {
    // best effort
  }
}

export function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/**
 * AgentRuntime — the public façade. Owns persistence, the event bus, tools, the scheduler
 * and the per-task orchestrators. All mutations of task state go through here.
 */
export class AgentRuntime {
  readonly rootDir: string;
  readonly dataDir: string;
  readonly persistence: Persistence;
  readonly bus: EventBus;
  readonly tools: ToolRegistry;
  readonly processes: ProcessManager;
  readonly verification = new VerificationEngine();
  readonly metrics = new MetricsCollector();
  readonly queue = new TaskQueue();
  readonly model: ModelProvider | null;
  readonly concurrency: number;
  readonly config: AgentOsConfig;
  readonly secrets: SecretVault | null;
  readonly sandbox: SandboxConfig;
  /** Resolved provider settings (profile, key source) for introspection — never the key value. */
  providerSettings: ResolvedProviderSettings | null = null;
  readonly mcpClients = new Map<string, McpClient>();
  mcpRegistrations: McpRegistration[] = [];
  private hooks: HookRunner | null = null;
  private orchestrator: Orchestrator;
  private running = new Map<string, RunningEntry>();
  private waiters = new Map<string, ((t: Task) => void)[]>();
  private controlTimer: NodeJS.Timeout | null = null;
  private daemonTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private scheduling = false;
  private defaultBudget: typeof DEFAULT_BUDGET;

  private constructor(opts: RuntimeOptions, persistence: Persistence) {
    this.rootDir = path.resolve(opts.rootDir ?? process.cwd());
    this.dataDir = path.resolve(opts.dataDir ?? path.join(this.rootDir, ".agentos"));
    this.persistence = persistence;
    this.bus = new EventBus(persistence, { jsonlMirror: opts.jsonlMirror ? path.join(this.dataDir, "events.jsonl") : undefined });
    this.model = opts.model ?? null;
    this.config = opts.config ?? {};
    this.secrets = opts.secrets === false || opts.secrets === null ? null : opts.secrets ?? null;
    this.sandbox = normalizeSandboxConfig(opts.sandbox === false ? undefined : opts.sandbox);
    const created = createDefaultToolRegistry({ allowDangerous: opts.allowDangerousCommands, shell: opts.shell, sandbox: this.sandbox.mode !== "none" ? this.sandbox : undefined });
    this.tools = opts.tools ?? created.registry;
    this.processes = created.processes;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.defaultBudget = { ...DEFAULT_BUDGET, ...(opts.defaultBudget ?? {}) };
    this.orchestrator = new Orchestrator({ persistence, bus: this.bus, tools: this.tools, verification: this.verification, model: this.model, dataDir: this.dataDir, heartbeatMs: opts.heartbeatMs, shell: opts.shell });
    this.metrics.attach(this.bus);
    if (this.sandbox.mode !== "none") this.verification.setSandbox(this.sandbox);
    if (this.config.hooks && Object.keys(this.config.hooks).length > 0) {
      this.hooks = new HookRunner(this.config.hooks, { rootDir: this.rootDir, bus: this.bus, shell: opts.shell });
      this.tools.setHooks(this.hooks);
    }
    if (opts.permissionMode === "confirm" && opts.onPermissionRequest) {
      this.tools.setPermissionGate({ mode: "confirm", request: opts.onPermissionRequest });
    }
    const pollMs = opts.controlPollMs ?? 500;
    if (pollMs > 0) {
      this.controlTimer = setInterval(() => this.pollControl().catch(() => undefined), pollMs);
      this.controlTimer.unref();
    }
  }

  static async create(opts: RuntimeOptions = {}): Promise<AgentRuntime> {
    const rootDir = path.resolve(opts.rootDir ?? process.cwd());
    const dataDir = path.resolve(opts.dataDir ?? path.join(rootDir, ".agentos"));
    await fsp.mkdir(dataDir, { recursive: true });
    let persistence: Persistence;
    const p = opts.persistence ?? "sqlite";
    if (typeof p === "string") {
      persistence = p === "memory" ? new MemoryPersistence() : p === "file" ? new FilePersistence(path.join(dataDir, "store")) : new SqlitePersistence(path.join(dataDir, "agentos.db"));
    } else persistence = p;
    await persistence.init();
    await excludeDataDirFromGit(rootDir, dataDir);
    const config = opts.config === undefined ? await loadAgentOsConfig(dataDir) : opts.config;
    const vault = opts.secrets === undefined ? await loadVault(dataDir) : opts.secrets || null;
    const sandbox = opts.sandbox === false ? undefined : opts.sandbox ?? config?.sandbox ?? (process.env.AGENTOS_SANDBOX ? normalizeSandboxConfig(process.env.AGENTOS_SANDBOX) : undefined);
    let model = opts.model;
    let providerSettings: ResolvedProviderSettings | null = null;
    if (model === undefined) {
      // profile-based resolution (config.llm → env → vault); null = deterministic mode
      providerSettings = await resolveProviderSettings({ env: process.env, vault, llm: config?.llm });
      model = providerSettings ? createProviderFromSettings(providerSettings) : null;
    }
    const rt = new AgentRuntime({ ...opts, rootDir, dataDir, config, secrets: vault, sandbox, model }, persistence);
    rt.providerSettings = providerSettings;
    if (config?.mcpServers && Object.keys(config.mcpServers).length > 0) {
      try {
        rt.mcpRegistrations = await registerMcpTools(rt.tools, config.mcpServers, {
          onClient: (name, client) => rt.mcpClients.set(name, client),
        });
        await rt.bus.emit({ taskId: null, agentId: null, type: "mcp.registered", data: { servers: rt.mcpRegistrations.map((r) => ({ server: r.server, tools: r.registeredTools })) } });
      } catch (err) {
        // a down MCP server must not take the whole runtime offline (Claude Code behaviour)
        for (const client of rt.mcpClients.values()) client.close();
        rt.mcpClients.clear();
        await rt.bus.emit({ taskId: null, agentId: null, type: "mcp.failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
    await rt.bus.syncSequence();
    for (const t of await persistence.listTasks()) rt.queue.upsert(t);
    return rt;
  }

  // ---- task lifecycle ------------------------------------------------------

  async createTask(spec: TaskSpec): Promise<Task> {
    const normalized = normalizeTaskSpec(spec, this.rootDir, this.defaultBudget);
    const workdir = normalized.workdir!;
    try {
      const st = await fsp.stat(workdir);
      if (!st.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new AgentOSError("INVALID_SPEC", `workdir does not exist: ${workdir}`);
    }
    const now = nowIso();
    const task: Task = {
      id: newTaskId(),
      spec: { ...normalized, workdir },
      status: "CREATED",
      priority: Number.isFinite(normalized.priority) ? Number(normalized.priority) : 0,
      dependsOn: [...(normalized.dependsOn ?? [])],
      budget: { ...this.defaultBudget, ...(normalized.budget ?? {}) },
      usage: { toolCalls: 0, tokens: 0, retries: 0, fixes: 0, elapsedMs: 0 },
      attempt: 0,
      workdir,
      createdAt: now,
      updatedAt: now,
    };
    this.queue.validateDependencies(task);
    this.queue.upsert(task);
    await this.persistence.saveTask(task);
    await this.bus.emit({ taskId: task.id, agentId: null, type: "task.created", data: { title: task.spec.title, priority: task.priority, dependsOn: task.dependsOn } });
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.queue.get(id);
  }

  async loadTask(id: string): Promise<Task | null> {
    return this.queue.get(id) ?? (await this.persistence.getTask(id));
  }

  listTasks(status?: TaskStatus[]): Task[] {
    return this.queue
      .all()
      .filter((t) => !status || status.includes(t.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Enqueue a task; the scheduler starts it when dependencies are met and a slot is free. */
  async startTask(id: string): Promise<Task> {
    const task = this.requireTask(id);
    if (this.running.has(id)) throw new AgentOSError("ALREADY_RUNNING", `task ${id} is already running`);
    if (!["CREATED", "PAUSED", "QUEUED", "FAILED", "CANCELLED", "BLOCKED"].includes(task.status)) {
      throw new AgentOSError("INVALID_TRANSITION", `cannot start task in status ${task.status}`);
    }
    if (task.status !== "PAUSED") await this.persistence.deleteCheckpoint(id);
    await this.setStatus(task, "QUEUED", "task.queued");
    this.schedule();
    return task;
  }

  /** Enqueue and wait for a terminal or paused state. */
  async runTask(id: string): Promise<Task> {
    await this.startTask(id);
    return this.waitForTask(id);
  }

  async pauseTask(id: string): Promise<Task> {
    const task = this.requireTask(id);
    const entry = this.running.get(id);
    if (entry) {
      entry.controller.abort("pause");
      return entry.promise;
    }
    if (task.status === "QUEUED") {
      await this.setStatus(task, "PAUSED", "task.paused");
      return task;
    }
    throw new AgentOSError("INVALID_TRANSITION", `cannot pause task in status ${task.status}`);
  }

  async resumeTask(id: string): Promise<Task> {
    const task = this.requireTask(id);
    if (task.status !== "PAUSED") throw new AgentOSError("INVALID_TRANSITION", `cannot resume task in status ${task.status}`);
    await this.setStatus(task, "QUEUED", "task.queued");
    this.schedule();
    return task;
  }

  async cancelTask(id: string): Promise<Task> {
    const task = this.requireTask(id);
    const entry = this.running.get(id);
    if (entry) {
      entry.controller.abort("cancel");
      return entry.promise;
    }
    if (TERMINAL_STATUSES.includes(task.status)) throw new AgentOSError("INVALID_TRANSITION", `task already ${task.status}`);
    task.finishedAt = nowIso();
    await this.setStatus(task, "CANCELLED", "task.cancelled");
    await this.persistence.deleteCheckpoint(id);
    this.resolveWaiters(task);
    this.schedule();
    return task;
  }

  /** Retry a FAILED/CANCELLED task from scratch (new attempt counter, fresh checkpoint). */
  async retryTask(id: string): Promise<Task> {
    const task = this.requireTask(id);
    if (!["FAILED", "CANCELLED", "BLOCKED"].includes(task.status)) throw new AgentOSError("INVALID_TRANSITION", `cannot retry task in status ${task.status}`);
    task.attempt = 0;
    task.error = undefined;
    task.result = undefined;
    task.finishedAt = undefined;
    task.startedAt = undefined;
    task.usage = { toolCalls: 0, tokens: 0, retries: task.usage.retries + 1, fixes: 0, elapsedMs: 0 };
    await this.persistence.deleteCheckpoint(id);
    await this.bus.emit({ taskId: id, agentId: null, type: "agent.retry", data: { scope: "manual" } });
    return this.startTask(id);
  }

  /**
   * Recover a task interrupted by a crash: load its checkpoint, verify the environment,
   * and resume from the last saved phase/step.
   */
  async recoverTask(id: string): Promise<{ task: Task; checkpoint: Checkpoint | null; warnings: string[] }> {
    const task = this.requireTask(id);
    if (this.running.has(id)) throw new AgentOSError("ALREADY_RUNNING", `task ${id} is already running`);
    const checkpoint = await this.persistence.loadCheckpoint(id);
    const warnings: string[] = [];
    if (!checkpoint) {
      if (ACTIVE_STATUSES.includes(task.status) || task.status === "QUEUED") {
        warnings.push("no checkpoint found; restarting from scratch");
        await this.persistence.deleteCheckpoint(id);
        await this.setStatus(task, "QUEUED", "task.queued");
        this.schedule();
      }
      return { task, checkpoint: null, warnings };
    }
    try {
      await fsp.access(checkpoint.workdir);
    } catch {
      task.status = "FAILED";
      task.error = `RECOVERY_FAILED: workdir missing: ${checkpoint.workdir}`;
      await this.persistence.saveTask(task);
      await this.bus.emit({ taskId: id, agentId: null, type: "task.failed", error: task.error, data: { recovery: true } });
      return { task, checkpoint, warnings: [task.error] };
    }
    if (checkpoint.worktree) {
      try {
        await fsp.access(checkpoint.worktree.path);
      } catch {
        warnings.push("isolated worktree missing; restarting attempt from scratch");
        await this.persistence.deleteCheckpoint(id);
        await this.setStatus(task, "QUEUED", "task.queued");
        this.schedule();
        return { task, checkpoint: null, warnings };
      }
    }
    const git = await getGitState(checkpoint.workdir);
    if (checkpoint.git?.isRepo && git.isRepo && checkpoint.git.head && git.head && checkpoint.git.head !== git.head) {
      warnings.push(`git HEAD changed since checkpoint (${checkpoint.git.head.slice(0, 8)} -> ${git.head.slice(0, 8)})`);
    }
    if (TERMINAL_STATUSES.includes(checkpoint.phase)) {
      warnings.push(`checkpoint already in terminal phase ${checkpoint.phase}`);
      return { task, checkpoint, warnings };
    }
    await this.bus.emit({ taskId: id, agentId: null, type: "task.recovering", data: { phase: checkpoint.phase, version: checkpoint.version, steps: checkpoint.completedSteps.length, warnings } });
    task.status = "PAUSED"; // normalise: recovery = resume from checkpoint
    await this.persistence.saveTask(task);
    await this.setStatus(task, "QUEUED", "task.queued");
    this.schedule();
    return { task, checkpoint, warnings };
  }

  /** Recovers every task that was active (or queued) when the previous process died. */
  async recoverAll(): Promise<{ recovered: string[]; warnings: Record<string, string[]> }> {
    const recovered: string[] = [];
    const warnings: Record<string, string[]> = {};
    for (const t of this.queue.all()) {
      if (this.running.has(t.id)) continue;
      if (ACTIVE_STATUSES.includes(t.status) || t.status === "QUEUED") {
        const r = await this.recoverTask(t.id);
        recovered.push(t.id);
        if (r.warnings.length) warnings[t.id] = r.warnings;
      }
    }
    return { recovered, warnings };
  }

  /** Tasks that would be recovered by recoverAll (diagnostics). */
  interruptedTasks(): Task[] {
    return this.queue.all().filter((t) => ACTIVE_STATUSES.includes(t.status) || t.status === "QUEUED");
  }

  waitForTask(id: string): Promise<Task> {
    const task = this.requireTask(id);
    if (TERMINAL_STATUSES.includes(task.status) || task.status === "PAUSED" || task.status === "BLOCKED") return Promise.resolve(task);
    const entry = this.running.get(id);
    if (entry) return entry.promise;
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  async waitForIdle(): Promise<void> {
    while (this.running.size > 0 || this.queue.ready().length > 0) {
      await Promise.all([...this.running.values()].map((e) => e.promise));
      this.schedule();
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  runningCount(): number {
    return this.running.size;
  }

  // ---- scheduler ------------------------------------------------------------

  private schedule(): void {
    if (this.closed || this.scheduling) return;
    this.scheduling = true;
    try {
      for (const blocked of this.queue.blocked()) {
        const dead = this.queue.deadDependencies(blocked);
        blocked.error = `BLOCKED: dependency ${dead.join(", ")} did not complete`;
        blocked.finishedAt = nowIso();
        void this.setStatus(blocked, "BLOCKED", "task.blocked", { dependencies: dead }).then(() => this.resolveWaiters(blocked));
      }
      for (const task of this.queue.ready()) {
        if (this.running.size >= this.concurrency) break;
        if (this.running.has(task.id)) continue;
        this.launch(task);
      }
    } finally {
      this.scheduling = false;
    }
  }

  private launch(task: Task): void {
    const controller = new AbortController();
    const promise = (async (): Promise<Task> => {
      let result: Task = task;
      try {
        const checkpoint = await this.persistence.loadCheckpoint(task.id);
        const resumable = checkpoint && !TERMINAL_STATUSES.includes(checkpoint.phase) && checkpoint.taskId === task.id;
        task.status = resumable ? checkpoint!.phase : "PLANNING";
        result = await this.orchestrator.run(task, { signal: controller.signal, checkpoint: resumable ? checkpoint : null });
      } catch (err) {
        // orchestrator handles its own errors; this is a last-resort guard so the scheduler never dies
        task.status = "FAILED";
        task.error = `RUNTIME_ERROR: ${err instanceof Error ? err.message : String(err)}`;
        task.finishedAt = nowIso();
        await this.persistence.saveTask(task).catch(() => undefined);
        await this.bus.emit({ taskId: task.id, agentId: null, type: "task.failed", error: task.error, data: { fatal: true } });
        result = task;
      } finally {
        await this.runTaskHooks(task).catch(() => undefined);
        this.processes.stopAllForTask(task.id);
        if (TERMINAL_STATUSES.includes(task.status)) await this.persistence.deleteCheckpoint(task.id).catch(() => undefined);
        this.running.delete(task.id);
        this.queue.upsert(task);
        this.resolveWaiters(task);
        await this.clearControl(task.id);
        setImmediate(() => this.schedule());
      }
      return result;
    })();
    this.running.set(task.id, { controller, promise });
    this.queue.upsert(task);
  }

  private resolveWaiters(task: Task) {
    const list = this.waiters.get(task.id);
    if (!list) return;
    this.waiters.delete(task.id);
    for (const w of list) w(task);
  }

  /** task_completed / task_failed hooks fire once the orchestrator reached a terminal status. */
  private async runTaskHooks(task: Task): Promise<void> {
    if (!this.hooks) return;
    if (task.status === "COMPLETED" && this.hooks.has("task_completed")) await this.hooks.taskCompleted(task.id, task.result?.summary ?? "");
    else if (task.status === "FAILED" && this.hooks.has("task_failed")) await this.hooks.taskFailed(task.id, task.error ?? null);
  }

  private requireTask(id: string): Task {
    const t = this.queue.get(id);
    if (!t) throw new AgentOSError("TASK_NOT_FOUND", `task not found: ${id}`);
    return t;
  }

  private async setStatus(task: Task, status: TaskStatus, eventType: string, data: Record<string, unknown> = {}) {
    task.status = status;
    task.updatedAt = nowIso();
    this.queue.upsert(task);
    await this.persistence.saveTask(task);
    await this.bus.emit({ taskId: task.id, agentId: null, type: eventType, data: { ...data, status } });
  }

  // ---- cross-process control channel ----------------------------------------

  private controlDir(): string {
    return path.join(this.dataDir, "control");
  }

  /** Write a control command for a task that is running in another process. */
  async sendControl(taskId: string, command: "pause" | "cancel"): Promise<void> {
    await fsp.mkdir(this.controlDir(), { recursive: true });
    await fsp.writeFile(path.join(this.controlDir(), `${taskId}.json`), JSON.stringify({ command, ts: nowIso(), pid: process.pid }));
  }

  private async clearControl(taskId: string) {
    await fsp.rm(path.join(this.controlDir(), `${taskId}.json`), { force: true }).catch(() => undefined);
  }

  private async pollControl(): Promise<void> {
    if (this.running.size === 0) return;
    let files: string[];
    try {
      files = await fsp.readdir(this.controlDir());
    } catch {
      return;
    }
    for (const f of files) {
      const taskId = f.replace(/\.json$/, "");
      const entry = this.running.get(taskId);
      if (!entry) continue;
      try {
        const cmd = JSON.parse(await fsp.readFile(path.join(this.controlDir(), f), "utf8")) as { command: string };
        if (cmd.command === "pause" || cmd.command === "cancel") {
          await this.bus.emit({ taskId, agentId: null, type: "task.control", data: { command: cmd.command, source: "control-file" } });
          entry.controller.abort(cmd.command);
        }
      } catch {
        // partial write — retry on next poll
        continue;
      }
      await this.clearControl(taskId);
    }
  }

  // ---- daemon mode: pick up QUEUED tasks written by other processes ----------

  startDaemon(pollMs = 1000): void {
    if (this.daemonTimer) return;
    this.daemonTimer = setInterval(async () => {
      if (this.closed) return;
      try {
        const persisted = await this.persistence.listTasks({ status: ["QUEUED", "CREATED", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"] });
        for (const t of persisted) {
          const known = this.queue.get(t.id);
          if (this.running.has(t.id)) continue;
          if (!known || known.updatedAt < t.updatedAt) this.queue.upsert(t);
        }
        this.schedule();
      } catch {
        // storage hiccup — try again next tick
      }
    }, pollMs);
    this.daemonTimer.unref();
  }

  stopDaemon(): void {
    if (this.daemonTimer) clearInterval(this.daemonTimer);
    this.daemonTimer = null;
  }

  // ---- introspection -------------------------------------------------------

  listAgents() {
    return AGENT_CATALOG;
  }

  listTools() {
    return this.tools.list();
  }

  async doctor(): Promise<DoctorReport> {
    const checks: DoctorReport["checks"] = [];
    const major = Number(process.versions.node.split(".")[0]);
    checks.push({ name: "node", ok: major >= 20, detail: `node ${process.versions.node}` });
    try {
      await fsp.access(this.dataDir);
      const probe = path.join(this.dataDir, `.probe-${process.pid}`);
      await fsp.writeFile(probe, "ok");
      await fsp.rm(probe);
      checks.push({ name: "dataDir", ok: true, detail: `${this.dataDir} writable` });
    } catch (err) {
      checks.push({ name: "dataDir", ok: false, detail: `${this.dataDir} not writable: ${err instanceof Error ? err.message : err}` });
    }
    try {
      const n = await this.persistence.countEvents();
      checks.push({ name: "persistence", ok: true, detail: `${this.persistence.kind} store, ${n} events, ${this.queue.size()} tasks` });
    } catch (err) {
      checks.push({ name: "persistence", ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
    const git = await getGitState(this.rootDir);
    checks.push({ name: "git", ok: true, detail: git.isRepo ? `repo on ${git.branch} @ ${git.head?.slice(0, 8)}${git.dirty ? " (dirty)" : ""}` : "rootDir is not a git repository (git tool still available)" });
    try {
      const { runCommand } = await import("./tools/terminal");
      const r = await runCommand("git --version && bash --version | head -1", { cwd: this.rootDir, timeoutMs: 5000 });
      checks.push({ name: "shell", ok: r.exitCode === 0, detail: r.stdout.trim().split("\n").join("; ") || r.stderr.trim() });
    } catch (err) {
      checks.push({ name: "shell", ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
    checks.push({ name: "model", ok: true, detail: this.model ? `provider ${this.model.name}${this.model.completeWithTools ? " (tool calling supported)" : ""}` : "no LLM configured — deterministic planner only (set LLM_API_KEY to enable)" });
    const ps = this.providerSettings;
    checks.push({
      name: "provider",
      ok: true,
      detail: ps
        ? `profile ${ps.profile.id} (${ps.profile.label}) key=${ps.keySource} streaming=${ps.quirks.toolStreaming} jsonMode=${ps.quirks.jsonMode}`
        : "no provider profile resolved (legacy env path or deterministic mode)",
    });
    checks.push({ name: "sandbox", ok: true, detail: this.sandbox.mode === "none" ? "none (policy + workspace guard only; set sandbox.mode=container for isolation)" : `${this.sandbox.mode} (image=${this.sandbox.image ?? "alpine:3"} mem=${this.sandbox.memoryMb}m network=${this.sandbox.network ? "on" : "none"})` });
    checks.push({ name: "secrets", ok: true, detail: this.secrets ? `vault at ${this.secrets.file} (${(await this.secrets.list()).length} entr${(await this.secrets.list()).length === 1 ? "y" : "ies"})` : "no vault (.agentos/secrets.json absent; `agentos secrets set` creates it)" });
    const hookCount = Object.values(this.config.hooks ?? {}).reduce((n, l) => n + (l?.length ?? 0), 0);
    checks.push({ name: "hooks", ok: true, detail: hookCount ? `${hookCount} hook(s) from .agentos/config.json` : "no hooks configured (.agentos/config.json)" });
    const mcpTools = this.tools.list().filter((t) => t.name.startsWith("mcp_"));
    checks.push({ name: "mcp", ok: true, detail: mcpTools.length ? `${mcpTools.length} MCP tool(s) from ${this.mcpRegistrations.length} server(s): ${mcpTools.map((t) => t.name).join(", ").slice(0, 300)}` : "no MCP servers configured (.agentos/config.json mcpServers)" });
    const interrupted = this.interruptedTasks();
    checks.push({ name: "interrupted", ok: true, detail: interrupted.length ? `${interrupted.length} task(s) need recovery: ${interrupted.map((t) => t.id).join(", ")}` : "no interrupted tasks" });
    const stats = this.bus.stats;
    checks.push({ name: "eventBus", ok: stats.pending === 0, detail: `seq=${stats.seq} pending=${stats.pending} dropped=${stats.droppedEvents} persistErrors=${stats.persistErrors}` });
    return { ok: checks.every((c) => c.ok), checks };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.controlTimer) clearInterval(this.controlTimer);
    this.stopDaemon();
    for (const client of this.mcpClients.values()) client.close();
    this.mcpClients.clear();
    for (const entry of this.running.values()) entry.controller.abort("pause");
    await Promise.allSettled([...this.running.values()].map((e) => e.promise));
    await this.processes.shutdown();
    await this.bus.flushPending();
    this.metrics.detach();
    await this.persistence.close();
  }
}
