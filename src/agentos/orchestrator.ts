import path from "node:path";
import fsp from "node:fs/promises";
import type { Checkpoint, Diagnosis, ModelProvider, Plan, StepResult, StepSpec, Task, TaskStatus } from "./types";
import { AgentOSError, errorMessage, nowIso } from "./types";
import type { Persistence } from "./persistence";
import { Mutex } from "./persistence";
import type { EventBus } from "./events";
import type { ToolRegistry } from "./tools/registry";
import { VerificationEngine } from "./verification";
import {
  AgenticLoopAgent,
  BudgetGuard,
  DebuggerAgent,
  ExecutorAgent,
  IntegratorAgent,
  PlannerAgent,
  ResearcherAgent,
  ReviewerAgent,
  TesterAgent,
  runAgent,
  type AgentContext,
  type Failure,
  type ResearchReport,
} from "./agents";
import type { Skill } from "./skills";
import type { AgenticConfig } from "./config";
import { getGitState, runGit } from "./tools/git";

export interface OrchestratorDeps {
  persistence: Persistence;
  bus: EventBus;
  tools: ToolRegistry;
  verification?: VerificationEngine;
  model?: ModelProvider | null;
  dataDir: string;
  /** How often (ms) to persist a heartbeat checkpoint while a long phase runs. */
  heartbeatMs?: number;
  shell?: string;
  /** User-authored skills injected into agentic system prompts. */
  skills?: Skill[];
  /** Agentic loop behaviour (parallel tool calls). */
  agentic?: Required<AgenticConfig>;
}

export class AbortedError extends Error {
  constructor(readonly reason: "pause" | "cancel") {
    super(reason);
    this.name = "AbortedError";
  }
}

export function newCheckpoint(task: Task): Checkpoint {
  return {
    taskId: task.id,
    version: 0,
    phase: "PLANNING",
    attempt: task.attempt,
    completedSteps: [],
    messages: [],
    verification: [],
    acceptance: [],
    workdir: task.workdir,
    usage: { ...task.usage },
    progress: 0,
    savedAt: nowIso(),
  };
}

const PHASE_PROGRESS: Partial<Record<TaskStatus, number>> = { PLANNING: 5, EXECUTING: 20, VERIFYING: 70, FIXING: 75, REVIEWING: 90, COMPLETED: 100 };

/**
 * Drives one task through its lifecycle:
 * PLANNING → EXECUTING → VERIFYING → (FIXING → VERIFYING)* → REVIEWING → COMPLETED
 * Failures go through DIAGNOSING → RETRYING (fresh attempt) or terminal FAILED.
 * A checkpoint is persisted at every transition and after every step.
 */
export class Orchestrator {
  private verification: VerificationEngine;
  private model: ModelProvider | null;
  private heartbeatMs: number;
  private skills: Skill[];
  private agentic: Required<AgenticConfig>;

  constructor(private deps: OrchestratorDeps) {
    this.verification = deps.verification ?? new VerificationEngine();
    this.model = deps.model ?? null;
    this.heartbeatMs = deps.heartbeatMs ?? 5000;
    this.skills = deps.skills ?? [];
    this.agentic = deps.agentic ?? { parallelToolCalls: true, maxParallel: 4 };
  }

  async run(task: Task, opts: { signal: AbortSignal; checkpoint?: Checkpoint | null }): Promise<Task> {
    const { bus, persistence } = this.deps;
    const cp = opts.checkpoint ?? newCheckpoint(task);
    const startedAt = Date.now();
    const budget = new BudgetGuard(task.budget, cp.usage, startedAt, cp.usage.elapsedMs);
    const resumed = !!opts.checkpoint;
    task.startedAt = task.startedAt ?? nowIso();
    const artifactsDir = path.join(this.deps.dataDir, "artifacts", task.id);
    const saveMutex = new Mutex();

    const save = async (): Promise<void> => saveMutex.run(async () => {
      cp.version++;
      cp.savedAt = nowIso();
      cp.usage.elapsedMs = budget.elapsedMs();
      task.usage = { ...cp.usage };
      task.updatedAt = cp.savedAt;
      // A lost checkpoint is a resumability degradation, never a reason to re-run
      // completed steps: absorb its failure (warning event) as long as the task
      // record itself persists. When saveTask fails too, the store is genuinely
      // down and the error propagates → the task fails (chaos contract).
      let cpError: string | null = null;
      try {
        await persistence.saveCheckpoint(cp);
      } catch (err) {
        cpError = errorMessage(err);
      }
      await persistence.saveTask(task);
      if (cpError) {
        await bus.emit({ taskId: task.id, agentId: null, type: "checkpoint.save_failed", error: cpError, data: { version: cp.version, phase: cp.phase, progress: cp.progress } }).catch(() => undefined);
        return;
      }
      await bus.emit({ taskId: task.id, agentId: null, type: "checkpoint.saved", data: { version: cp.version, phase: cp.phase, progress: cp.progress, steps: cp.completedSteps.length } });
    });

    const setPhase = async (phase: TaskStatus): Promise<void> => {
      const from = cp.phase;
      cp.phase = phase;
      task.status = phase;
      cp.progress = PHASE_PROGRESS[phase] ?? cp.progress;
      // COMPLETED emits its own final event (with duration) from the COMPLETED handler
      if (phase !== "COMPLETED") await bus.emit({ taskId: task.id, agentId: null, type: `task.${phase.toLowerCase()}`, data: { from, attempt: task.attempt } });
      await save();
    };

    const ctx = (): AgentContext => ({
      task,
      checkpoint: cp,
      tools: this.deps.tools,
      bus,
      signal: opts.signal,
      model: this.model,
      verification: this.verification,
      budget,
      workdir: cp.worktree?.path ?? task.workdir,
      artifactsDir,
      shell: this.deps.shell,
      skills: this.skills,
      agentic: this.agentic,
    });

    const heartbeat = setInterval(() => {
      // Route heartbeats through the same save mutex as phase/step writes so a
      // stale snapshot can never overwrite a newer checkpoint.
      void save().catch(() => undefined);
    }, this.heartbeatMs);
    heartbeat.unref();

    await bus.emit({ taskId: task.id, agentId: null, type: resumed ? "task.resumed" : "task.started", data: { attempt: task.attempt, phase: cp.phase, fromVersion: cp.version } });
    const planner = new PlannerAgent();
    const researcher = new ResearcherAgent();
    const executor = new ExecutorAgent();
    const tester = new TesterAgent();
    const reviewer = new ReviewerAgent();
    const debuggerAgent = new DebuggerAgent();
    const integrator = new IntegratorAgent();

    let pendingFailure: Failure | null = null;
    let lastDiagnosis: Diagnosis | undefined = cp.diagnosis;
    let research: ResearchReport | null = null;

    const throwIfAborted = () => {
      if (opts.signal.aborted) throw new AbortedError(opts.signal.reason === "cancel" ? "cancel" : "pause");
    };

    const planCursor = (): number => {
      const ids = new Set((cp.plan?.steps ?? []).map((s) => s.id));
      return cp.completedSteps.filter((r) => ids.has(r.stepId) && r.ok).length;
    };

    const executeSteps = async (steps: StepSpec[], label: string): Promise<StepResult | null> => {
      const { output } = await runAgent(executor, ctx(), {
        steps,
        label,
        onStep: async (r) => {
          cp.completedSteps.push(r);
          const total = cp.plan?.steps.length ?? 1;
          cp.progress = Math.min(69, 20 + Math.round((planCursor() / total) * 49));
          await save();
        },
      });
      if (output.failed) {
        cp.completedSteps.push(output.failed);
        await save();
      }
      return output.failed;
    };

    try {
      // Isolated worktree setup (parallel agents each get their own checkout)
      if (task.spec.isolated && !cp.worktree && cp.phase === "PLANNING") {
        const state = await getGitState(task.workdir);
        if (!state.isRepo) throw new AgentOSError("ISOLATION_UNAVAILABLE", "isolated=true requires the workdir to be a git repository");
        const branch = `agentos/${task.id}`;
        const wtPath = path.join(this.deps.dataDir, "worktrees", task.id);
        await fsp.mkdir(path.dirname(wtPath), { recursive: true });
        const r = await runGit(["worktree", "add", "-b", branch, wtPath, "HEAD"], { cwd: task.workdir, signal: opts.signal });
        if (r.exitCode !== 0) throw new AgentOSError("WORKTREE_FAILED", r.stderr.trim());
        cp.worktree = { path: wtPath, branch, baseBranch: state.branch ?? "HEAD" };
        cp.git = state;
        await bus.emit({ taskId: task.id, agentId: null, type: "workspace.isolated", data: { path: wtPath, branch } });
        await save();
      }
      if (!cp.git) cp.git = await getGitState(task.workdir);

      // main state machine
      for (;;) {
        throwIfAborted();
        budget.checkDeadline();
        switch (cp.phase) {
          case "PLANNING": {
            if (task.spec.mode === "agentic") {
              if (!this.model?.completeWithTools) throw new AgentOSError("MODEL_REQUIRED", "mode=agentic requires a model provider with native tool calling (set LLM_API_KEY)");
              // skills hot-reload: long-running runtimes pick up new/edited skills per task
              try {
                const { loadSkills } = await import("./skills");
                this.skills = (await loadSkills(path.join(this.deps.dataDir, "skills"))).skills;
              } catch {
                // keep the previously loaded set
              }
              // the researcher's report seeds the agentic conversation with workspace context
              research = (await runAgent(researcher, ctx(), undefined)).output;
              cp.plan = { steps: [], rationale: "agentic mode: the model drives tool calls directly; verification and review still gate completion", source: "model" };
              await bus.emit({ taskId: task.id, agentId: null, type: "task.planned", data: { source: "agentic", steps: 0, rationale: cp.plan.rationale } });
              await save();
              await setPhase("EXECUTING");
              break;
            }
            if (!task.spec.steps?.length && this.model) research = (await runAgent(researcher, ctx(), undefined)).output;
            cp.plan = (await runAgent(planner, ctx(), { research })).output;
            await setPhase("EXECUTING");
            break;
          }
          case "EXECUTING": {
            if (task.spec.mode === "agentic") {
              const agentic = new AgenticLoopAgent();
              let turns = 0;
              const { output } = await runAgent(agentic, ctx(), {
                research,
                onTurn: async (r) => {
                  turns++;
                  cp.completedSteps.push(r);
                  cp.progress = Math.min(69, 20 + turns);
                  await save();
                },
              });
              cp.finalMessage = output.finalMessage;
              await save();
              await setPhase("VERIFYING");
              break;
            }
            const plan = cp.plan as Plan;
            const remaining = plan.steps.slice(planCursor());
            const failed = await executeSteps(remaining, "plan");
            if (failed) {
              pendingFailure = { kind: "step", step: plan.steps.find((s) => s.id === failed.stepId)!, result: failed };
              await setPhase("FIXING");
            } else {
              await setPhase("VERIFYING");
            }
            break;
          }
          case "VERIFYING": {
            cp.verification = (await runAgent(tester, ctx(), undefined)).output;
            await save();
            if (cp.verification.every((v) => v.passed) && (cp.acceptance ?? []).every((a) => a.passed)) await setPhase("REVIEWING");
            else {
              pendingFailure = cp.verification.some((v) => !v.passed)
                ? { kind: "verification", results: cp.verification }
                : { kind: "acceptance", results: cp.acceptance ?? [] };
              await setPhase("FIXING");
            }
            break;
          }
          case "FIXING": {
            if (!pendingFailure) {
              // resumed mid-fix: recompute what is wrong
              const plan = cp.plan as Plan;
              const lastFailed = [...cp.completedSteps].reverse().find((r) => !r.ok);
              const failedStep = lastFailed && plan.steps.find((s) => s.id === lastFailed.stepId);
              pendingFailure = failedStep
                ? { kind: "step", step: failedStep, result: lastFailed! }
                : cp.verification.some((v) => !v.passed)
                  ? { kind: "verification", results: cp.verification }
                  : (cp.acceptance ?? []).some((a) => !a.passed)
                    ? { kind: "acceptance", results: cp.acceptance ?? [] }
                  : cp.review
                    ? { kind: "review", review: cp.review }
                    : { kind: "error", error: new AgentOSError("UNKNOWN_FAILURE", "resumed in FIXING without a recorded failure") };
            }
            cp.usage.fixes++;
            if (cp.usage.fixes > task.budget.maxRetries) {
              throw new AgentOSError("FIX_ATTEMPTS_EXHAUSTED", `self-correction exhausted after ${task.budget.maxRetries} attempts`, { details: { failure: pendingFailure.kind } });
            }
            const diagnosis: Diagnosis = (await runAgent(debuggerAgent, ctx(), pendingFailure as Failure)).output;
            lastDiagnosis = cp.diagnosis = diagnosis;
            await save();
            if (!diagnosis.retryable) {
              throw new AgentOSError("UNRECOVERABLE", diagnosis.rootCause, { details: { diagnosis } });
            }
            const fixSteps: StepSpec[] = (diagnosis.suggestedSteps ?? []).map((s: StepSpec, i: number) => ({ ...s, id: `fix${cp.usage.fixes}-${i + 1}-${s.id}` }));
            if (fixSteps.length) {
              const failedFix = await executeSteps(fixSteps, "fix");
              if (failedFix) {
                pendingFailure = { kind: "step", step: fixSteps.find((s) => s.id === failedFix.stepId)!, result: failedFix };
                await setPhase("FIXING");
                break;
              }
              // a re-run of a failed plan step counts as completing it
              if (pendingFailure.kind === "step") {
                const original = pendingFailure.step;
                const fixed = cp.completedSteps.find((r) => r.stepId === `fix${cp.usage.fixes}-1-${original.id}` && r.ok);
                if (fixed) cp.completedSteps.push({ ...fixed, stepId: original.id });
              }
            }
            pendingFailure = null;
            await bus.emit({ taskId: task.id, agentId: null, type: "agent.retry", data: { scope: "fix", fixes: cp.usage.fixes, category: diagnosis.category } });
            await setPhase(planCursor() < (cp.plan?.steps.length ?? 0) ? "EXECUTING" : "VERIFYING");
            break;
          }
          case "REVIEWING": {
            const plan = cp.plan as Plan;
            cp.review = (await runAgent(reviewer, ctx(), { plan, stepResults: cp.completedSteps, verification: cp.verification, acceptance: cp.acceptance ?? [] })).output;
            await save();
            if (cp.review.verdict === "PASS") {
              if (cp.worktree) {
                const res = (await runAgent(integrator, ctx(), { worktree: cp.worktree, message: `agentos(${task.id}): ${task.spec.title}` })).output;
                if (!res.merged) throw new AgentOSError("MERGE_CONFLICT", "integration failed: merge conflict (rolled back)", { details: res.conflicts });
                cp.worktree = undefined;
              }
              await setPhase("COMPLETED");
              break;
            }
            pendingFailure = { kind: "review", review: cp.review };
            await setPhase("FIXING");
            break;
          }
          case "COMPLETED": {
            task.result = this.buildResult(cp, lastDiagnosis, "completed: review PASS with verification evidence");
            task.finishedAt = nowIso();
            task.error = undefined;
            await save();
            await bus.emit({ taskId: task.id, agentId: null, type: "task.completed", durationMs: budget.elapsedMs(), data: { attempt: task.attempt, steps: cp.completedSteps.length, toolCalls: cp.usage.toolCalls } });
            return task;
          }
          default:
            throw new AgentOSError("INVALID_PHASE", `cannot resume from phase ${cp.phase}`);
        }
      }
    } catch (err) {
      if (err instanceof AbortedError || opts.signal.aborted) {
        const reason: "pause" | "cancel" = opts.signal.reason === "cancel" ? "cancel" : "pause";
        task.status = reason === "cancel" ? "CANCELLED" : "PAUSED";
        if (reason === "cancel") task.finishedAt = nowIso();
        await save();
        await bus.emit({ taskId: task.id, agentId: null, type: reason === "cancel" ? "task.cancelled" : "task.paused", durationMs: budget.elapsedMs(), data: { phase: cp.phase, progress: cp.progress } });
        return task;
      }
      // ---- failure path: DIAGNOSING → RETRYING | FAILED
      const failure: Failure = pendingFailure && (err as AgentOSError).code === "FIX_ATTEMPTS_EXHAUSTED" ? pendingFailure : { kind: "error", error: err };
      let diagnosis: Diagnosis;
      try {
        await setPhase("DIAGNOSING");
        diagnosis = (await runAgent(debuggerAgent, ctx(), failure)).output;
      } catch (diagErr) {
        diagnosis = { rootCause: errorMessage(err), category: "unknown", retryable: false, attemptsSummary: [`diagnosis failed: ${errorMessage(diagErr)}`], recommendedNextAction: "inspect event log" };
      }
      cp.diagnosis = diagnosis;
      const code = (err as AgentOSError).code;
      const canRetry = diagnosis.retryable && code !== "BUDGET_EXCEEDED" && code !== "FIX_ATTEMPTS_EXHAUSTED" && task.attempt < task.budget.maxRetries;
      if (canRetry && !opts.signal.aborted) {
        task.attempt++;
        cp.usage.retries++;
        await setPhase("RETRYING");
        await bus.emit({ taskId: task.id, agentId: null, type: "agent.retry", data: { scope: "task", attempt: task.attempt, rootCause: diagnosis.rootCause } });
        // fresh attempt: keep messages/usage, reset plan progress
        const fresh = newCheckpoint(task);
        fresh.messages = cp.messages;
        fresh.usage = cp.usage;
        fresh.version = cp.version;
        fresh.worktree = cp.worktree;
        fresh.git = cp.git;
        clearInterval(heartbeat);
        return this.run(task, { signal: opts.signal, checkpoint: fresh });
      }
      task.status = "FAILED";
      task.error = `${code ?? "ERROR"}: ${errorMessage(err)}`;
      task.finishedAt = nowIso();
      task.result = this.buildResult(cp, diagnosis, `failed: ${task.error}`);
      if (cp.worktree) {
        await runGit(["worktree", "remove", "--force", cp.worktree.path], { cwd: task.workdir }).catch(() => undefined);
      }
      await save();
      await this.writeFailureAnalysis(task, cp, diagnosis).catch(() => undefined);
      await bus.emit({ taskId: task.id, agentId: null, type: "task.failed", durationMs: budget.elapsedMs(), error: task.error, data: { attempt: task.attempt, category: diagnosis.category, rootCause: diagnosis.rootCause } });
      return task;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private buildResult(cp: Checkpoint, diagnosis: Diagnosis | undefined, summary: string) {
    return { plan: cp.plan, stepResults: cp.completedSteps, verification: cp.verification, acceptance: cp.acceptance ?? [], review: cp.review, diagnosis, summary, ...(cp.finalMessage ? { finalMessage: cp.finalMessage } : {}) };
  }

  private async writeFailureAnalysis(task: Task, cp: Checkpoint, d: Diagnosis): Promise<void> {
    const dir = path.join(this.deps.dataDir, "failures");
    await fsp.mkdir(dir, { recursive: true });
    const lines = [
      `# FAILURE ANALYSIS — ${task.spec.title} (${task.id})`,
      "",
      `Generated: ${nowIso()}`,
      "",
      "## Root cause",
      d.rootCause,
      "",
      `Category: ${d.category} · Retryable: ${d.retryable} · Attempt: ${task.attempt}/${task.budget.maxRetries} · Fix attempts: ${cp.usage.fixes}`,
      "",
      "## Attempts",
      ...(d.attemptsSummary.length ? d.attemptsSummary.map((a) => `- ${a}`) : ["- (no recorded attempts)"]),
      "",
      "## Why attempts failed",
      ...cp.completedSteps.filter((r) => !r.ok).map((r) => `- ${r.stepId}: ${r.error}`),
      ...cp.verification.filter((v) => !v.passed).map((v) => `- verification ${v.name}: exit ${v.exitCode} ${v.stderr.slice(0, 300).replace(/\n/g, " ")}`),
      ...(cp.acceptance ?? []).filter((a) => !a.passed).map((a) => `- acceptance ${a.check.description ?? a.check.type}: ${a.detail}`),
      ...(cp.review?.issues ?? []).filter((i) => i.severity !== "low").map((i) => `- review ${i.category}/${i.severity}: ${i.message}`),
      "",
      "## Current state",
      `- Phase at failure: ${cp.phase}`,
      `- Completed steps: ${cp.completedSteps.filter((r) => r.ok).length}/${cp.plan?.steps.length ?? 0}`,
      `- Tool calls: ${cp.usage.toolCalls}/${task.budget.maxToolCalls} · Tokens: ${cp.usage.tokens}/${task.budget.maxTokens} · Elapsed: ${cp.usage.elapsedMs}ms/${task.budget.timeoutMs}ms`,
      `- Workdir: ${task.workdir}`,
      `- Git: ${cp.git?.isRepo ? `${cp.git.branch}@${cp.git.head?.slice(0, 8)} dirty=${cp.git.dirty}` : "not a repository"}`,
      "",
      "## Recommended next action",
      d.recommendedNextAction,
      "",
    ];
    await fsp.writeFile(path.join(dir, `FAILURE_ANALYSIS-${task.id}.md`), lines.join("\n"));
  }
}
