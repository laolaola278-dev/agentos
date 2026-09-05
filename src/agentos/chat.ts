import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { AgentRuntime } from "./runtime";
import type { AcceptanceCheck, AgentEvent, PermissionRequest } from "./types";

/** Persisted chat session: one entry per completed turn (`agentos chat --resume`). */
export interface ChatSessionEntry {
  ts: string;
  goal: string;
  status: string;
  summary?: string;
}

interface ChatSessionFile {
  version: 1;
  turns: ChatSessionEntry[];
}

const SESSION_MAX_TURNS = 50;

function sessionFile(dataDir: string): string {
  return path.join(dataDir, "chat-session.json");
}

export async function saveChatSession(dataDir: string, entry: ChatSessionEntry): Promise<void> {
  const file = sessionFile(dataDir);
  let parsed: ChatSessionFile = { version: 1, turns: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ChatSessionFile;
    if (raw.version === 1 && Array.isArray(raw.turns)) parsed = raw;
  } catch {
    // first entry
  }
  parsed.turns.push(entry);
  if (parsed.turns.length > SESSION_MAX_TURNS) parsed.turns = parsed.turns.slice(-SESSION_MAX_TURNS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
}

export async function loadChatSession(dataDir: string): Promise<ChatSessionEntry[] | null> {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(dataDir), "utf8")) as ChatSessionFile;
    return raw.version === 1 && Array.isArray(raw.turns) ? raw.turns : null;
  } catch {
    return null;
  }
}

/** Builds the carry-over context injected into the first turn of a resumed session. */
export function sessionContextBlock(turns: ChatSessionEntry[], maxTurns = 8, maxChars = 3000): string {
  const recent = turns.filter((t) => t.goal).slice(-maxTurns);
  if (!recent.length) return "";
  const lines = recent.map((t) => `- [${t.status}] ${t.goal.replace(/\s+/g, " ").slice(0, 200)}${t.summary ? ` → ${t.summary.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  let block = lines.join("\n");
  if (block.length > maxChars) block = block.slice(-maxChars);
  return `[previous session context — completed turns and outcomes]\n${block}`;
}

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
  /allow <pat>    session-allow a tool pattern (no more prompts for it)
  /auto           run without permission prompts
  /confirm        ask before every tool call (default)
  /exit           leave chat`;

/**
 * One conversational turn: creates an agentic task, streams its events, waits for
 * completion. Kept separate from the readline loop so it is directly testable.
 */
export async function chatTurn(rt: AgentRuntime, text: string, handlers: ChatHandlers, opts: { budget?: { maxToolCalls?: number; timeoutMs?: number }; acceptance?: AcceptanceCheck[]; context?: string } = {}): Promise<ChatTurnResult> {
  if (!rt.model?.completeWithTools) {
    throw new Error("chat needs an LLM with tool calling — set LLM_API_KEY (and LLM_BASE_URL / LLM_MODEL)");
  }
  const goal = opts.context ? `[previous session context]\n${opts.context}\n\n[current request] ${text}` : text;
  const task = await rt.createTask({
    title: text.slice(0, 80),
    goal,
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
  /** Injectable streams for tests; default to stdin/stdout. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Reload the persisted session and seed the first turn with its context. */
  resume?: boolean;
  /** Extra slash commands (name without "/", e.g. "mystatus"). */
  extraCommands?: Record<string, { description: string; handler: (arg: string) => void | Promise<void> }>;
}

/**
 * Interactive REPL around the agentic loop: `agentos chat`.
 * Permission prompts reuse the readline interface; approval is the default binding (Enter).
 */
export async function runChat(rt: AgentRuntime, opts: ChatOptions = {}): Promise<number> {
  const out: NodeJS.WritableStream = opts.output ?? process.stdout;
  const write = (text: string): void => {
    out.write(text);
  };
  const print = (line: string): void => {
    out.write(`${line}\n`);
  };
  const rl = readline.createInterface({ input: opts.input ?? process.stdin, output: opts.output ? (opts.output as NodeJS.WriteStream) : process.stdout, terminal: !opts.input });
  // Node's readline/promises leaves a pending question() unsettled forever when the
  // input stream ends (EOF) or the interface closes — race every question against an
  // explicit closed signal so EOF / Ctrl-C always terminate the loop.
  const inputStream = opts.input ?? process.stdin;
  let inputClosed = false;
  let rejectClosed: ((err: Error) => void) | null = null;
  const closedSignal = new Promise<never>((_, reject) => {
    rejectClosed = reject;
  });
  closedSignal.catch(() => undefined); // never let the signal reject unobserved (e.g. EOF mid-task)
  const markClosed = () => {
    if (!inputClosed) {
      inputClosed = true;
      rejectClosed?.(new Error("chat input closed"));
    }
  };
  if ((inputStream as NodeJS.ReadableStream & { readableEnded?: boolean }).readableEnded) markClosed();
  else inputStream.once("end", markClosed);
  inputStream.once("close", markClosed);
  const ask = (query: string): Promise<string> => Promise.race([rl.question(query), closedSignal]) as Promise<string>;
  // serialize permission prompts; the runtime may deny-parallel several calls
  let permissionChain: Promise<boolean> = Promise.resolve(true);
  const askPermission = async (req: PermissionRequest): Promise<boolean> => {
    const next = permissionChain.then(async () => {
      const answer = await ask(`\n[confirm] allow ${req.tool}.${req.action}? (y/N) `).catch(() => "n"); // closed input denies (fail-closed)
      return /^y(es)?$/i.test(answer.trim());
    });
    permissionChain = next.catch(() => false);
    return next;
  };
  rt.tools.setPermissionGate({ mode: opts.autoApprove ? "auto" : "confirm", request: askPermission });

  const baseHandlers: ChatHandlers = {
    print,
    printDelta: write,
  };

  rt.bus.subscribe((e) => {
    if (e.type === "hook.executed" && (e.data as { blocked?: boolean } | undefined)?.blocked) {
      print(`  ⛔ hook: ${e.error ?? "blocked"}`);
    }
  }, { typePrefix: "hook." });

  print(BANNER);
  let exitCode = 0;
  let running: string | null = null;
  let exitRequested = false;
  // session resume: persisted turns seed the first turn's context (Claude Code --resume)
  let sessionTurns = opts.resume ? (await loadChatSession(rt.dataDir)) ?? [] : [];
  let turnContext = "";
  if (opts.resume && sessionTurns.length) {
    turnContext = sessionContextBlock(sessionTurns);
    print(`resumed session: ${sessionTurns.length} prior turn(s) carried over`);
  }
  // slash command registry — extensible via opts.extraCommands
  interface SlashCommand {
    description: string;
    handler: (arg: string) => void | Promise<void>;
  }
  const commands = new Map<string, SlashCommand>();
  const define = (name: string, description: string, handler: SlashCommand["handler"]) => commands.set(name, { description, handler });
  define("exit", "leave chat", () => {
    exitRequested = true;
  });
  define("quit", "leave chat", () => {
    exitRequested = true;
  });
  define("help", "show commands", () => {
    print(BANNER);
    print("registered commands:");
    for (const [name, cmd] of commands) print(`  /${name.padEnd(10)} ${cmd.description}`);
  });
  define("tools", "list available tools", () => {
    for (const t of rt.listTools()) print(`  ${t.name}: ${t.actions.map((a) => a.name).join(", ")}`);
  });
  define("tasks", "recent tasks", () => {
    for (const t of rt.listTasks().slice(0, 10)) print(`  ${t.id}  ${t.status}  ${t.spec.title}`);
  });
  define("allow", "session-allow a tool pattern (e.g. terminal.*)", (arg) => {
    if (!arg) {
      print("usage: /allow tool.action   (e.g. /allow terminal.*)");
      return;
    }
    try {
      rt.tools.allowToolPattern(arg);
      print(`session allow added: ${arg} (no prompt for matching calls)`);
    } catch (err) {
      print(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  define("auto", "run without permission prompts", () => {
    rt.tools.setPermissionGate(null);
    print("permission mode: auto (no prompts)");
  });
  define("confirm", "ask before every tool call", () => {
    rt.tools.setPermissionGate({ mode: "confirm", request: askPermission });
    print("permission mode: confirm");
  });
  define("history", "show persisted session turns", () => {
    if (!sessionTurns.length) return print("(no persisted session turns)");
    for (const t of sessionTurns.slice(-10)) print(`  [${t.ts.slice(0, 19)}] [${t.status}] ${t.goal.replace(/\s+/g, " ").slice(0, 120)}`);
  });
  define("new", "clear the persisted session", () => {
    sessionTurns = [];
    turnContext = "";
    try {
      fs.rmSync(sessionFile(rt.dataDir), { force: true });
    } catch {
      // nothing to clear
    }
    print("session cleared");
  });
  for (const [name, cmd] of Object.entries(opts.extraCommands ?? {})) {
    if (commands.has(name)) throw new Error(`slash command /${name} already exists`);
    commands.set(name, cmd);
  }
  rl.on("SIGINT", () => {
    if (running) {
      print("\n(cancel current task…)");
      void rt.cancelTask(running).catch(() => undefined);
    } else {
      markClosed();
      rl.close();
    }
  });
  try {
    for (;;) {
      let line: string;
      try {
        line = (await ask("\nagentos> ")).trim();
      } catch {
        break; // stdin closed / Ctrl-C at prompt
      }
      if (!line) continue;
      if (line.startsWith("/")) {
        const [name, ...rest] = line.split(/\s+/);
        const cmd = commands.get(name.slice(1));
        if (!cmd) {
          print(`unknown command: ${name}`);
          continue;
        }
        await cmd.handler(rest.join(" "));
        if (exitRequested) break;
        continue;
      }
      const handlers: ChatHandlers = {
        ...baseHandlers,
        onStart: (taskId) => {
          running = taskId;
        },
      };
      try {
        const res = await chatTurn(rt, line, handlers, { budget: { maxToolCalls: opts.maxToolCalls }, context: turnContext });
        turnContext = ""; // carry-over context applies to the first resumed turn only
        sessionTurns.push({ ts: new Date().toISOString(), goal: line, status: res.status, summary: res.summary });
        await saveChatSession(rt.dataDir, sessionTurns.at(-1)!);
        if (res.status === "FAILED") exitCode = 1;
      } catch (err) {
        print(`error: ${err instanceof Error ? err.message : String(err)}`);
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
