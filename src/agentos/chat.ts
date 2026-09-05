import readline from "node:readline/promises";
import { AgentRuntime } from "./runtime";
import type { AcceptanceCheck, AgentEvent, PermissionRequest } from "./types";

export interface ChatHandlers {
  /** Print a full line. */
  print: (line: string) => void;
  /** Print streamed text without a trailing newline (model token deltas). */
  printDelta: (text: string) => void;
  /** Called as soon as the turn's task has been created (enables Ctrl-C cancellation). */
  onStart?: (taskId: string) => void;
  /** Ask the user to approve or deny a tool call (confirm permission mode). */
  askPermission?: (req: PermissionRequest) => Promise<boolean>;
}

export interface ChatTurnResult {
  taskId: string;
  status: string;
  summary?: string;
  error?: string;
}

const BANNER = `AgentOS chat — type a goal; the agent works on this directory with live output.
  /tools          list available tools
  /tasks          recent tasks
  /auto           run without permission prompts
  /confirm        ask before every tool call (default)
  /exit           leave chat`;

/**
 * One conversational turn: creates an agentic task, streams its events, waits for
 * completion. Kept separate from the readline loop so it is directly testable.
 */
export async function chatTurn(rt: AgentRuntime, text: string, handlers: ChatHandlers, opts: { budget?: { maxToolCalls?: number; timeoutMs?: number }; acceptance?: AcceptanceCheck[] } = {}): Promise<ChatTurnResult> {
  if (!rt.model?.completeWithTools) {
    throw new Error("chat needs an LLM with tool calling — set LLM_API_KEY (and LLM_BASE_URL / LLM_MODEL)");
  }
  const task = await rt.createTask({
    title: text.slice(0, 80),
    goal: text,
    mode: "agentic",
    budget: { maxToolCalls: opts.budget?.maxToolCalls ?? 100, timeoutMs: opts.budget?.timeoutMs ?? 10 * 60_000 },
    ...(opts.acceptance?.length ? { acceptance: opts.acceptance } : {}),
  });
  handlers.onStart?.(task.id);
  let inDelta = false;
  const unsub = rt.bus.subscribe((e: AgentEvent) => {
    switch (e.type) {
      case "model.delta": {
        inDelta = true;
        handlers.printDelta(String((e.data as { text?: string } | undefined)?.text ?? ""));
        return;
      }
      case "agent.tool_call": {
        if (inDelta) {
          handlers.printDelta("\n");
          inDelta = false;
        }
        handlers.print(`  ⚙ ${e.tool}.${(e.args as { action?: string } | undefined)?.action ?? ""}`);
        return;
      }
      case "tool.completed": {
        if (inDelta) {
          handlers.printDelta("\n");
          inDelta = false;
        }
        handlers.print(`  ✓ ${e.tool} (${e.durationMs ?? 0}ms)`);
        return;
      }
      case "tool.failed": {
        if (inDelta) {
          handlers.printDelta("\n");
          inDelta = false;
        }
        handlers.print(`  ✗ ${e.tool}: ${e.error ?? "failed"}`);
        return;
      }
      case "model.completed": {
        if (inDelta) {
          handlers.printDelta("\n");
          inDelta = false;
        }
        return;
      }
      case "task.verifying":
      case "review.completed": {
        if (inDelta) {
          handlers.printDelta("\n");
          inDelta = false;
        }
        const verdict = (e.data as { verdict?: string } | undefined)?.verdict;
        handlers.print(`  ${e.type === "review.completed" ? `review: ${verdict ?? "?"}` : "verifying…"}`);
        return;
      }
      default:
        return;
    }
  }, { taskId: task.id });
  try {
    if (inDelta) handlers.printDelta("\n");
    const done = await rt.runTask(task.id);
    const summary = done.status === "COMPLETED" ? done.result?.finalMessage ?? done.result?.summary ?? "" : undefined;
    handlers.print(`\n[${done.status}]${summary ? ` ${summary.slice(0, 2000)}` : ""}${done.error ? ` ${done.error}` : ""}`);
    return { taskId: task.id, status: done.status, summary, error: done.error };
  } finally {
    unsub();
  }
}

interface ChatOptions {
  autoApprove?: boolean;
  maxToolCalls?: number;
}

/**
 * Interactive REPL around the agentic loop: `agentos chat`.
 * Permission prompts reuse the readline interface; approval is the default binding (Enter).
 */
export async function runChat(rt: AgentRuntime, opts: ChatOptions = {}): Promise<number> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // serialize permission prompts; the runtime may deny-parallel several calls
  let permissionChain: Promise<boolean> = Promise.resolve(true);
  const askPermission = async (req: PermissionRequest): Promise<boolean> => {
    const next = permissionChain.then(async () => {
      const answer = await rl.question(`\n[confirm] allow ${req.tool}.${req.action}? (y/N) `);
      return /^y(es)?$/i.test(answer.trim());
    });
    permissionChain = next.catch(() => false);
    return next;
  };
  rt.tools.setPermissionGate({ mode: opts.autoApprove ? "auto" : "confirm", request: askPermission });

  const baseHandlers: ChatHandlers = {
    print: (line) => console.log(line),
    printDelta: (text) => process.stdout.write(text),
  };

  rt.bus.subscribe((e) => {
    if (e.type === "hook.executed" && (e.data as { blocked?: boolean } | undefined)?.blocked) {
      console.log(`  ⛔ hook: ${e.error ?? "blocked"}`);
    }
  }, { typePrefix: "hook." });

  console.log(BANNER);
  let exitCode = 0;
  let running: string | null = null;
  rl.on("SIGINT", () => {
    if (running) {
      console.log("\n(cancel current task…)");
      void rt.cancelTask(running).catch(() => undefined);
    } else {
      rl.close();
    }
  });
  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question("\nagentos> ")).trim();
      } catch {
        break; // stdin closed / Ctrl-C at prompt
      }
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/help" || line === "/?") {
        console.log(BANNER);
        continue;
      }
      if (line === "/tools") {
        for (const t of rt.listTools()) console.log(`  ${t.name}: ${t.actions.map((a) => a.name).join(", ")}`);
        continue;
      }
      if (line === "/tasks") {
        for (const t of rt.listTasks().slice(0, 10)) console.log(`  ${t.id}  ${t.status}  ${t.spec.title}`);
        continue;
      }
      if (line === "/auto") {
        rt.tools.setPermissionGate(null);
        console.log("permission mode: auto (no prompts)");
        continue;
      }
      if (line === "/confirm") {
        rt.tools.setPermissionGate({ mode: "confirm", request: askPermission });
        console.log("permission mode: confirm");
        continue;
      }
      if (line.startsWith("/")) {
        console.log(`unknown command: ${line}`);
        continue;
      }
      const handlers: ChatHandlers = {
        ...baseHandlers,
        onStart: (taskId) => {
          running = taskId;
        },
      };
      try {
        const res = await chatTurn(rt, line, handlers, { budget: { maxToolCalls: opts.maxToolCalls } });
        if (res.status === "FAILED") exitCode = 1;
      } catch (err) {
        console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
        exitCode = 1;
      } finally {
        running = null;
      }
    }
  } finally {
    rl.close();
  }
  return exitCode;
}
