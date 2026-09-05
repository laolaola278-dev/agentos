import { performance } from "node:perf_hooks";
import type { Tool, ToolActionDef, ToolContext, ToolErrorInfo, ToolInput, ToolOutput } from "../types";
import { ToolError, errorMessage, isAbortError } from "../types";
import type { EventBus } from "../events";
import { buildSafeEnv } from "../security";

export interface ToolDescriptor {
  name: string;
  description: string;
  actions: ToolActionDef[];
}

export interface ExecuteOptions {
  taskId: string;
  agentId: string;
  workdir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string>;
  bus?: EventBus | null;
  maxOutputBytes?: number;
  shell?: string;
}

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** Combines an optional parent signal with a timeout. */
export function combineSignals(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new ToolError("TIMEOUT", `operation timed out after ${timeoutMs}ms`, { retryable: true }));
  }, timeoutMs);
  const onParentAbort = () => controller.abort(parent?.reason ?? "aborted");
  if (parent) {
    if (parent.aborted) onParentAbort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
    timedOut: () => timedOut,
  };
}

/** Truncates strings inside a result payload so a single tool call cannot exhaust memory / logs. */
export function truncatePayload(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  let truncated = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return "[depth-limit]";
    if (typeof v === "string") {
      if (Buffer.byteLength(v) > maxBytes) {
        truncated = true;
        return v.slice(0, maxBytes) + `\n…[truncated ${Buffer.byteLength(v) - maxBytes} bytes]`;
      }
      return v;
    }
    if (Array.isArray(v)) {
      if (v.length > 5000) {
        truncated = true;
        return v.slice(0, 5000).map((x) => walk(x, depth + 1));
      }
      return v.map((x) => walk(x, depth + 1));
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, depth + 1);
      return out;
    }
    return v;
  };
  return { value: walk(value, 0), truncated };
}

export function toToolErrorInfo(err: unknown): ToolErrorInfo {
  if (err instanceof ToolError) return { code: err.code, message: err.message, retryable: err.retryable, details: err.details };
  if (isAbortError(err)) return { code: "ABORTED", message: errorMessage(err), retryable: false };
  const e = err as NodeJS.ErrnoException;
  if (e && typeof e === "object" && typeof e.code === "string") {
    const retryable = ["EBUSY", "EAGAIN", "ETIMEDOUT", "ECONNRESET", "EMFILE", "ENFILE"].includes(e.code);
    return { code: e.code, message: e.message, retryable };
  }
  return { code: "TOOL_ERROR", message: errorMessage(err), retryable: false };
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string, action?: string): boolean {
    const t = this.tools.get(name);
    if (!t) return false;
    if (!action) return true;
    return t.actions.some((a) => a.name === action);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, actions: t.actions }));
  }

  /**
   * Executes a tool action with timeout, cancellation, output capping and event logging.
   * Never throws: all failures become a structured ToolOutput.
   */
  async execute(toolName: string, input: ToolInput, opts: ExecuteOptions): Promise<ToolOutput> {
    const started = performance.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const bus = opts.bus ?? null;
    const base = { taskId: opts.taskId, agentId: opts.agentId, tool: toolName };
    const finish = (out: Omit<ToolOutput, "durationMs" | "tool" | "action">): ToolOutput => ({
      ...out,
      tool: toolName,
      action: input.action,
      durationMs: Math.round(performance.now() - started),
    });

    const tool = this.tools.get(toolName);
    if (!tool) {
      const output = finish({ ok: false, error: { code: "UNKNOWN_TOOL", message: `unknown tool: ${toolName}`, retryable: false } });
      await bus?.emit({ ...base, type: "tool.failed", args: input, error: output.error!.message, durationMs: output.durationMs });
      return output;
    }
    if (!tool.actions.some((a) => a.name === input.action)) {
      const output = finish({
        ok: false,
        error: { code: "UNKNOWN_ACTION", message: `unknown action ${toolName}.${input.action}`, retryable: false },
      });
      await bus?.emit({ ...base, type: "tool.failed", args: input, error: output.error!.message, durationMs: output.durationMs });
      return output;
    }

    await bus?.emit({ ...base, type: "tool.started", args: input });
    const { signal, cleanup, timedOut } = combineSignals(opts.signal, timeoutMs);
    const logs: string[] = [];
    const ctx: ToolContext = {
      taskId: opts.taskId,
      agentId: opts.agentId,
      workdir: opts.workdir,
      signal,
      timeoutMs,
      env: buildSafeEnv(opts.env ?? {}),
      shell: opts.shell,
      log: (m) => {
        if (logs.length < 200) logs.push(m);
      },
    };
    try {
      const raceAbort = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      const raw = await Promise.race([tool.execute(input, ctx), raceAbort]);
      const { value, truncated } = truncatePayload(raw, maxOutputBytes);
      const output = finish({ ok: true, data: value, truncated: truncated || undefined });
      await bus?.emit({ ...base, type: "tool.completed", args: input, result: value, durationMs: output.durationMs, data: logs.length ? { logs } : undefined });
      return output;
    } catch (err) {
      let info = toToolErrorInfo(err);
      if (timedOut()) info = { code: "TIMEOUT", message: `tool timed out after ${timeoutMs}ms`, retryable: true };
      const output = finish({ ok: false, error: info });
      await bus?.emit({ ...base, type: "tool.failed", args: input, error: `${info.code}: ${info.message}`, durationMs: output.durationMs, data: { code: info.code, retryable: info.retryable } });
      return output;
    } finally {
      cleanup();
    }
  }
}

/** Helper for tools: validate a required argument. */
export function requireArg<T>(args: Record<string, unknown>, key: string, type: "string" | "number" | "boolean" | "object" = "string"): T {
  const v = args[key];
  if (v === undefined || v === null) throw new ToolError("MISSING_ARGUMENT", `missing required argument: ${key}`);
  if (type === "object" ? typeof v !== "object" : typeof v !== type) {
    throw new ToolError("INVALID_ARGUMENT", `argument ${key} must be of type ${type}`);
  }
  return v as T;
}

export function optionalArg<T>(args: Record<string, unknown>, key: string, fallback: T): T {
  const v = args[key];
  return v === undefined || v === null ? fallback : (v as T);
}
