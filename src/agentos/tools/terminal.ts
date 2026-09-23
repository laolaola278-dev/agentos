import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Tool, ToolActionDef, ToolContext, ToolInput } from "../types";
import { ToolError } from "../types";
import { assertCommandAllowed, buildSafeEnv, resolveSafePath } from "../security";
import { optionalArg, requireArg } from "./registry";
import { planSandboxedCommand, type SandboxConfig } from "../sandbox";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  killed: boolean;
  durationMs: number;
  truncated: boolean;
  pid?: number;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  allowDangerous?: boolean;
  onProcess?: (p: ChildProcess) => void;
  /** Optional shell executable. Defaults to a platform-appropriate shell. */
  shell?: string;
}

export interface ShellSpec {
  file: string;
  args: (command: string) => string[];
  kind: "bash" | "cmd" | "powershell" | "sh";
}

const WINDOWS_SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  11: "SIGSEGV",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
};

/** Git Bash/MSYS encodes a signal as (signal << 8) in the Windows exit code. */
function decodeExitSignal(exitCode: number | null, signal: NodeJS.Signals | null): { exitCode: number | null; signal: NodeJS.Signals | null } {
  if (signal || process.platform !== "win32" || exitCode === null || exitCode < 256) return { exitCode, signal };
  const n = (exitCode >>> 8) & 0xff;
  const name = WINDOWS_SIGNAL_NAMES[n];
  return name ? { exitCode: null, signal: name as NodeJS.Signals } : { exitCode, signal };
}

/** Resolve a shell without assuming a POSIX filesystem. */
export function resolveShell(requested?: string, env: NodeJS.ProcessEnv = process.env): ShellSpec {
  const explicit = requested?.trim() || env.AGENTOS_SHELL?.trim();
  const classify = (file: string): ShellSpec => {
    const lower = path.basename(file).toLowerCase();
    if (lower === "cmd.exe" || lower === "cmd") return { file, kind: "cmd", args: (command) => ["/d", "/s", "/c", command] };
    if (["powershell.exe", "powershell", "pwsh.exe", "pwsh"].includes(lower)) {
      return { file, kind: "powershell", args: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
    }
    // `-c` is sufficient for non-interactive commands and avoids login-shell
    // startup files (which can be slow or mutate the agent's environment).
    return { file, kind: lower === "sh" || lower === "sh.exe" ? "sh" : "bash", args: (command) => ["-c", command] };
  };
  if (explicit) return classify(explicit);

  const pathValue = env.PATH ?? env.Path ?? "";
  const find = (names: string[]): string | undefined => {
    for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          if (fs.statSync(candidate).isFile()) {
            // `Git\\bin\\bash.exe` is a launcher that can detach the real
            // process and make tree termination unreliable. Prefer the
            // sibling `usr\\bin\\bash.exe` when present.
            if (process.platform === "win32" && /[\\/]bin[\\/]bash(?:\.exe)?$/i.test(candidate)) {
              const direct = path.resolve(path.dirname(candidate), "..", "usr", "bin", path.basename(candidate));
              try {
                if (fs.statSync(direct).isFile()) return direct;
              } catch {
                // use the discovered launcher below
              }
            }
            return candidate;
          }
        } catch {
          // continue searching
        }
      }
    }
    return undefined;
  };
  if (process.platform === "win32") {
    const bash = find(["bash.exe", "bash"]);
    if (bash) return classify(bash);
    const pwsh = find(["pwsh.exe", "powershell.exe"]);
    if (pwsh) return classify(pwsh);
    return classify(env.ComSpec || "cmd.exe");
  }
  return classify(env.SHELL || (fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh"));
}

function spawnShell(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean; stdio: any; shell?: string }): ChildProcess {
  const spec = resolveShell(opts.shell, opts.env);
  const prepared = spec.kind === "bash" && process.platform === "win32" ? adaptWindowsPathsForMsys(command) : command;
  return spawn(spec.file, spec.args(prepared), {
    cwd: opts.cwd,
    env: opts.env,
    detached: opts.detached,
    stdio: opts.stdio,
    windowsHide: true,
  });
}

/** Convert native drive paths embedded in a Bash command to MSYS paths. */
function adaptWindowsPathsForMsys(command: string): string {
  // Stop at shell metacharacters, but retain spaces so paths such as
  // `C:\Program Files\repo` are handled when quoted or used by `cd`.
  return command.replace(/(?<![A-Za-z0-9_])([A-Za-z]):\\([^'"`;&|<>\r\n]*)/g, (_whole, drive: string, rest: string) => {
    const cleaned = rest.replace(/\\/g, "/").replace(/[ \t]+$/, "");
    const trailing = rest.slice(cleaned.length).replace(/\\/g, "/");
    return `/${drive.toLowerCase()}/${cleaned}${trailing}`;
  });
}

class OutputBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private max: number) {}
  push(chunk: Buffer) {
    if (this.size >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.size;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size += room;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }
  toString() {
    // Normalise CRLF at the command boundary so persisted evidence is
    // consistent across Windows and POSIX hosts.
    const s = Buffer.concat(this.chunks).toString("utf8").replace(/\r\n/g, "\n");
    return this.truncated ? s + "\n…[output truncated]" : s;
  }
}

/** Kills a whole process group: SIGTERM, then SIGKILL after a grace period. */
export function killTree(child: ChildProcess, graceMs = 1500): void {
  // On Windows the short-lived Git Bash launcher can already have exited
  // while its descendant still owns the stdio handles, so do not return early
  // solely from the launcher's exitCode.
  if (!child.pid || (process.platform !== "win32" && (child.exitCode !== null || child.signalCode !== null))) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    // Windows has no negative-PID process groups. Ask taskkill while the
    // launcher PID is still alive, then repeat after a short grace period in
    // case Git Bash has spawned its real child executable in the meantime.
    const taskKill = () => {
      try {
        // Synchronous here is intentional: callers often remove the task
        // workdir immediately after stop/cancel.  Returning before taskkill
        // completes leaves a descendant with an open cwd and causes EBUSY.
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 2000 });
      } catch {
        /* best effort; child.kill below is the fallback */
      }
    };
    taskKill();
    const t = setTimeout(() => {
      taskKill();
      try {
        // If taskkill was unavailable, retain a direct fallback.
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, Math.min(graceMs, 300));
    t.unref();
    return;
  }
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  send("SIGTERM");
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) send("SIGKILL");
  }, graceMs);
  t.unref();
}

/**
 * Runs a shell command in its own process group with output caps, timeout and cancellation.
 * Resolves (never rejects) with a structured result for non-zero exits, crashes and timeouts.
 * Rejects only for policy violations (dangerous command / invalid arguments).
 */
export function runCommand(command: string, opts: RunCommandOptions): Promise<CommandResult> {
  assertCommandAllowed(command, opts.allowDangerous);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxOut = opts.maxOutputBytes ?? 256 * 1024;
  const started = performance.now();
  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      const env = (opts.env ?? buildSafeEnv()) as NodeJS.ProcessEnv;
      child = spawnShell(command, { cwd: opts.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"], shell: opts.shell });
    } catch (err) {
      resolve({
        command,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        killed: false,
        durationMs: 0,
        truncated: false,
      });
      return;
    }
    opts.onProcess?.(child);
    const stdout = new OutputBuffer(maxOut);
    const stderr = new OutputBuffer(maxOut);
    let timedOut = false;
    let killed = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      killTree(child);
      forceTimer ??= setTimeout(() => finish(null, "SIGTERM", undefined, true), 1000);
      forceTimer.unref();
    }, timeoutMs);

    const onAbort = () => {
      killed = true;
      killTree(child);
      // Descendants may inherit the stdio handles after the shell exits. Do
      // not make callers wait indefinitely for a `close` event in that case.
      forceTimer ??= setTimeout(() => finish(null, "SIGTERM", undefined, true), 1000);
      forceTimer.unref();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (c: Buffer) => stdout.push(c));
    child.stderr?.on("data", (c: Buffer) => stderr.push(c));
    child.stdin?.on("error", () => undefined);
    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end(); // interactive prompts get EOF instead of hanging forever

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error, forced = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (forced) {
        // A descendant can keep the stdio pipes open after the shell has been
        // terminated.  Detach those handles so a timed-out task cannot keep
        // the host process alive; the OS tree kill above remains best effort.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        child.unref();
      }
      const spawnMessage = spawnError
        ? ((spawnError as NodeJS.ErrnoException).code === "ENOENT"
            ? `command or working directory not found: ${spawnError.message}`
            : spawnError.message)
        : undefined;
      const decoded = decodeExitSignal(exitCode, signal);
      resolve({
        command,
        exitCode: decoded.exitCode,
        signal: decoded.signal,
        stdout: stdout.toString(),
        stderr: spawnMessage ? `${stderr.toString()}${spawnMessage}` : stderr.toString(),
        timedOut,
        killed,
        durationMs: Math.round(performance.now() - started),
        truncated: stdout.truncated || stderr.truncated,
        pid: child.pid,
      });
    };
    child.on("error", (err) => finish(null, null, err));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

// ---------------------------------------------------------------------------
// Background processes (shared by terminal + process tools)
// ---------------------------------------------------------------------------

export interface ManagedProcess {
  id: string;
  pid: number | undefined;
  command: string;
  taskId: string;
  startedAt: string;
  exitCode: number | null;
  signal: string | null;
  running: boolean;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  child: ChildProcess;
  finished: Promise<void>;
  /** Internal resolver used to make an explicit stop observable immediately. */
  resolveFinished?: () => void;
  stopRequested?: boolean;
}

export class ProcessManager {
  private procs = new Map<string, ManagedProcess>();
  private counter = 0;

  constructor(private maxProcesses = 32) {}

  start(command: string, opts: { cwd: string; env?: Record<string, string>; taskId: string; maxOutputBytes?: number; allowDangerous?: boolean; shell?: string }): ManagedProcess {
    assertCommandAllowed(command, opts.allowDangerous);
    const running = [...this.procs.values()].filter((p) => p.running).length;
    if (running >= this.maxProcesses) throw new ToolError("TOO_MANY_PROCESSES", `background process limit reached (${this.maxProcesses})`, { retryable: true });
    const child: ChildProcess = spawnShell(command, {
      cwd: opts.cwd,
      env: (opts.env ?? buildSafeEnv()) as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: opts.shell,
    });
    const id = `proc_${++this.counter}_${Date.now().toString(36)}`;
    const max = opts.maxOutputBytes ?? 256 * 1024;
    let resolveFinished!: () => void;
    const mp: ManagedProcess = {
      id,
      pid: child.pid,
      command,
      taskId: opts.taskId,
      startedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      running: true,
      stdout: new OutputBuffer(max),
      stderr: new OutputBuffer(max),
      child,
      finished: new Promise<void>((resolve) => {
        resolveFinished = resolve;
        child.on("error", () => {
          mp.running = false;
          resolve();
        });
        child.on("close", (code, sig) => {
          const decoded = decodeExitSignal(code, sig);
          mp.exitCode = decoded.exitCode;
          mp.signal = decoded.signal;
          mp.running = false;
          resolve();
        });
      }),
    };
    mp.resolveFinished = resolveFinished;
    child.stdout?.on("data", (c: Buffer) => mp.stdout.push(c));
    child.stderr?.on("data", (c: Buffer) => mp.stderr.push(c));
    this.procs.set(id, mp);
    return mp;
  }

  get(id: string): ManagedProcess {
    const p = this.procs.get(id);
    if (!p) throw new ToolError("NOT_FOUND", `no managed process with id ${id}`);
    return p;
  }

  snapshot(p: ManagedProcess) {
    return {
      id: p.id,
      pid: p.pid,
      command: p.command,
      taskId: p.taskId,
      startedAt: p.startedAt,
      running: p.running,
      exitCode: p.exitCode,
      signal: p.signal,
      stdout: p.stdout.toString(),
      stderr: p.stderr.toString(),
    };
  }

  list(taskId?: string) {
    return [...this.procs.values()].filter((p) => !taskId || p.taskId === taskId).map((p) => this.snapshot(p));
  }

  stop(id: string): void {
    const p = this.get(id);
    if (p.running) {
      p.stopRequested = true;
      p.signal ??= "SIGTERM";
      // Mark the logical process stopped immediately.  The OS kill remains
      // asynchronous, but callers must not block on inherited pipe handles.
      p.running = false;
      p.resolveFinished?.();
      killTree(p.child);
    }
  }

  async wait(id: string, timeoutMs: number): Promise<boolean> {
    const p = this.get(id);
    if (!p.running) return true;
    const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref());
    return Promise.race([p.finished.then(() => true), timeout]);
  }

  remove(id: string): void {
    const p = this.procs.get(id);
    if (p?.running) killTree(p.child);
    this.procs.delete(id);
  }

  async shutdown(): Promise<void> {
    for (const p of this.procs.values()) if (p.running) killTree(p.child, 500);
    await Promise.all([...this.procs.values()].map((p) => Promise.race([p.finished, new Promise((r) => setTimeout(r, 2500).unref())])));
    this.procs.clear();
  }

  stopAllForTask(taskId: string): number {
    let n = 0;
    for (const p of this.procs.values()) {
      if (p.taskId === taskId && p.running) {
        killTree(p.child);
        n++;
      }
    }
    return n;
  }
}

export class TerminalTool implements Tool {
  name = "terminal";
  description = "Run shell commands (bash) inside the task workdir with timeout and output limits";
  actions: ToolActionDef[] = [
    { name: "execute", description: "Run a command and wait for exit", params: { command: "string", cwd: "string?", timeoutMs: "number?", input: "string?", maxOutputBytes: "number?", env: "object?" } },
    { name: "start", description: "Start a background process", params: { command: "string", cwd: "string?" } },
    { name: "poll", description: "Read status/output of a background process", params: { id: "string" } },
    { name: "stop", description: "Terminate a background process", params: { id: "string" } },
  ];

  constructor(private processes: ProcessManager, private opts: { allowDangerous?: boolean; shell?: string; sandbox?: SandboxConfig; sandboxAvailable?: () => Promise<boolean> } = {}) {}

  async execute(input: ToolInput, ctx: ToolContext): Promise<unknown> {
    const a = input.args ?? {};
    switch (input.action) {
      case "execute": {
        const command = requireArg<string>(a, "command");
        const cwd = a.cwd ? resolveSafePath(ctx.workdir, String(a.cwd)) : ctx.workdir;
        const extraEnv = optionalArg<Record<string, string>>(a, "env", {});
        const plan = this.opts.sandbox
          ? await planSandboxedCommand(command, { workdir: cwd, cfg: this.opts.sandbox, available: this.opts.sandboxAvailable })
          : { command, cleanup: async () => undefined, mode: "none" as const };
        try {
          const result = await runCommand(plan.command, {
            cwd,
            timeoutMs: Math.min(optionalArg(a, "timeoutMs", ctx.timeoutMs), ctx.timeoutMs),
            env: buildSafeEnv(extraEnv),
            input: optionalArg<string | undefined>(a, "input", undefined),
            maxOutputBytes: optionalArg(a, "maxOutputBytes", 256 * 1024),
            signal: ctx.signal,
            allowDangerous: this.opts.allowDangerous,
            shell: ctx.shell ?? this.opts.shell,
          });
          if (plan.note) (result as CommandResult & { sandboxNote?: string }).sandboxNote = plan.note;
          if (result.timedOut) throw new ToolError("TIMEOUT", `command timed out after ${result.durationMs}ms`, { retryable: true, details: result });
          if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new ToolError("ABORTED", String(ctx.signal.reason));
          return result;
        } finally {
          await plan.cleanup();
        }
      }
      case "start": {
        const command = requireArg<string>(a, "command");
        const cwd = a.cwd ? resolveSafePath(ctx.workdir, String(a.cwd)) : ctx.workdir;
        const p = this.processes.start(command, { cwd, env: ctx.env, taskId: ctx.taskId, allowDangerous: this.opts.allowDangerous, shell: ctx.shell ?? this.opts.shell });
        return { id: p.id, pid: p.pid, command };
      }
      case "poll":
        // Windows process launchers can deliver the final buffered chunk a
        // few milliseconds after the child starts. A tiny settle window makes
        // polling deterministic without changing the long-running process
        // semantics (callers can still poll repeatedly for live output).
        await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 350 : 0));
        return this.processes.snapshot(this.processes.get(requireArg(a, "id")));
      case "stop": {
        const id = requireArg<string>(a, "id");
        this.processes.stop(id);
        await this.processes.wait(id, 3000);
        return this.processes.snapshot(this.processes.get(id));
      }
      default:
        throw new ToolError("UNKNOWN_ACTION", `unknown terminal action ${input.action}`);
    }
  }
}

export class ProcessTool implements Tool {
  name = "process";
  description = "Inspect and control background processes started by this runtime (never arbitrary PIDs)";
  actions: ToolActionDef[] = [
    { name: "list", description: "List managed processes", params: { taskId: "string?" }, readOnly: true },
    { name: "kill", description: "Kill a managed process", params: { id: "string" } },
    { name: "wait", description: "Wait for a managed process to exit", params: { id: "string", timeoutMs: "number?" } },
    { name: "output", description: "Get process output", params: { id: "string" }, readOnly: true },
  ];

  constructor(private processes: ProcessManager) {}

  async execute(input: ToolInput, ctx: ToolContext): Promise<unknown> {
    const a = input.args ?? {};
    switch (input.action) {
      case "list":
        return { processes: this.processes.list(optionalArg<string | undefined>(a, "taskId", undefined)) };
      case "kill": {
        const id = requireArg<string>(a, "id");
        this.processes.stop(id);
        await this.processes.wait(id, 3000);
        return this.processes.snapshot(this.processes.get(id));
      }
      case "wait": {
        const id = requireArg<string>(a, "id");
        const finished = await this.processes.wait(id, Math.min(optionalArg(a, "timeoutMs", ctx.timeoutMs), ctx.timeoutMs));
        return { finished, ...this.processes.snapshot(this.processes.get(id)) };
      }
      case "output": {
        const p = this.processes.get(requireArg(a, "id"));
        return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), running: p.running };
      }
      default:
        throw new ToolError("UNKNOWN_ACTION", `unknown process action ${input.action}`);
    }
  }
}
