import type { EventInput } from "./types";
import type { EventBus } from "./events";
import type { HookConfig, HookEvent } from "./config";
import { runCommand } from "./tools/terminal";
import { matchToolPattern } from "./tools/registry";
import { buildSafeEnv, redactSecrets } from "./security";

export interface HookRunnerOptions {
  rootDir: string;
  bus?: EventBus | null;
  shell?: string;
}

export interface HookOutcome {
  event: HookEvent;
  matched: number;
  blocked: boolean;
  message?: string;
}

interface HookPayloadInput {
  event: HookEvent;
  taskId: string | null;
  tool?: string;
  action?: string;
  args?: unknown;
  result?: unknown;
  status?: string;
  error?: string | null;
}

/** true when the hook pattern matches `tool.action` (`*`, `tool`, `tool.*`, `tool.action`). */
export function hookMatches(match: string | undefined, tool: string, action: string): boolean {
  return matchToolPattern(match, tool, action);
}

/**
 * Runs lifecycle hooks from `.agentos/config.json` (Claude Code semantics):
 * a `pre_tool_call` hook that exits with code 2 blocks the tool call with its
 * stderr as the reason; any other non-zero exit is recorded but non-blocking.
 */
export class HookRunner {
  constructor(private hooks: Partial<Record<HookEvent, HookConfig[]>>, private opts: HookRunnerOptions) {}

  has(event: HookEvent): boolean {
    return (this.hooks[event]?.length ?? 0) > 0;
  }

  list(): Partial<Record<HookEvent, HookConfig[]>> {
    return this.hooks;
  }

  private async run(event: HookEvent, payload: HookPayloadInput, signal?: AbortSignal): Promise<HookOutcome> {
    const configs = this.hooks[event] ?? [];
    const tool = payload.tool ?? "";
    const action = payload.action ?? "";
    const matched = configs.filter((c) => hookMatches(c.match, tool, action));
    let blocked = false;
    let message: string | undefined;
    for (const cfg of matched) {
      const started = Date.now();
      const res = await runCommand(cfg.command, {
        cwd: this.opts.rootDir,
        timeoutMs: cfg.timeoutMs ?? 30_000,
        allowDangerous: true, // hooks are user-authored config, like Claude Code settings hooks
        input: JSON.stringify(redactSecrets(payload), null, 2),
        signal,
        shell: this.opts.shell,
        env: buildSafeEnv({
          AGENTOS_HOOK_EVENT: event,
          ...(payload.tool ? { AGENTOS_TOOL: payload.tool } : {}),
          ...(payload.action ? { AGENTOS_ACTION: payload.action } : {}),
          ...(payload.taskId ? { AGENTOS_TASK_ID: payload.taskId } : {}),
        }),
      });
      const blocking = event === "pre_tool_call" && res.exitCode === 2;
      if (blocking) {
        blocked = true;
        message = (res.stderr.trim() || res.stdout.trim() || `blocked by hook: ${cfg.command}`).slice(0, 2000);
      }
      await this.emit({
        taskId: payload.taskId,
        agentId: null,
        type: "hook.executed",
        tool: payload.tool || null,
        error: blocking ? message : res.exitCode !== 0 ? `hook exit ${res.exitCode}: ${(res.stderr || res.stdout).slice(0, 500)}` : null,
        data: {
          event,
          match: cfg.match ?? "*",
          command: cfg.command,
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          blocked: blocking,
          durationMs: Date.now() - started,
        },
      });
    }
    return { event, matched: matched.length, blocked, message };
  }

  preToolCall(taskId: string, tool: string, action: string, args: unknown, signal?: AbortSignal): Promise<HookOutcome> {
    return this.run("pre_tool_call", { event: "pre_tool_call", taskId, tool, action, args }, signal);
  }

  postToolCall(taskId: string, tool: string, action: string, result: unknown, signal?: AbortSignal): Promise<HookOutcome> {
    return this.run("post_tool_call", { event: "post_tool_call", taskId, tool, action, result }, signal);
  }

  taskCompleted(taskId: string, summary: string): Promise<HookOutcome> {
    return this.run("task_completed", { event: "task_completed", taskId, status: "COMPLETED", result: { summary } });
  }

  taskFailed(taskId: string, error: string | null): Promise<HookOutcome> {
    return this.run("task_failed", { event: "task_failed", taskId, status: "FAILED", error });
  }

  private async emit(event: EventInput): Promise<void> {
    try {
      await this.opts.bus?.emit(event);
    } catch {
      // hook event emission must never break the tool call path
    }
  }
}
