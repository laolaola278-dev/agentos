import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import type { AcceptanceCheck, AcceptanceResult, VerificationKind, VerificationResult, VerificationSpec } from "./types";
import { runCommand } from "./tools/terminal";
import type { EventBus } from "./events";
import { resolveSafePath, redactString } from "./security";
import { planSandboxedCommand, type SandboxConfig } from "./sandbox";

export const VERIFICATION_PRESETS: Record<Exclude<VerificationKind, "custom">, string> = {
  unit: "npm test",
  integration: "npm run test:integration",
  e2e: "npm run test:e2e",
  lint: "npm run lint",
  typecheck: "npm run typecheck",
  build: "npm run build",
};

export interface VerifyOptions {
  workdir: string;
  signal?: AbortSignal;
  artifactsDir?: string;
  taskId?: string;
  agentId?: string;
  bus?: EventBus | null;
  defaultTimeoutMs?: number;
  shell?: string;
  /** Stop after the first failed check (default false for complete evidence). */
  failFast?: boolean;
  /** Sandbox tier applied to verification commands. */
  sandbox?: SandboxConfig;
}

/**
 * Independent verification engine: runs objective checks (tests, lint, typecheck, build, custom commands)
 * and returns structured evidence. Agents may not declare success without a passing VerificationResult.
 */
export class VerificationEngine {
  private sandbox?: SandboxConfig;

  /** Sets a default sandbox tier for every verification command (per-call opts still win). */
  setSandbox(sandbox?: SandboxConfig): this {
    this.sandbox = sandbox;
    return this;
  }

  async run(spec: VerificationSpec, opts: VerifyOptions): Promise<VerificationResult> {
    const command = spec.command || (spec.kind !== "custom" ? presetFor(spec.kind, opts.workdir) : "");
    const cwd = spec.cwd ? resolveSafePath(opts.workdir, spec.cwd) : opts.workdir;
    const timeoutMs = spec.timeoutMs ?? opts.defaultTimeoutMs ?? 5 * 60_000;
    const base = { taskId: opts.taskId ?? null, agentId: opts.agentId ?? null, tool: "verification" };
    await opts.bus?.emit({ ...base, type: "test.started", data: { name: spec.name, kind: spec.kind, command } });
    let result: VerificationResult;
    if (!command) {
      result = { name: spec.name, kind: spec.kind, command, passed: false, exitCode: null, stdout: "", stderr: "no command configured", durationMs: 0, artifacts: [], timedOut: false };
    } else {
      const plan = opts.sandbox ?? this.sandbox
        ? await planSandboxedCommand(command, { workdir: cwd, cfg: (opts.sandbox ?? this.sandbox)! })
        : { command, cleanup: async () => undefined, mode: "none" as const };
      try {
        const r = await runCommand(plan.command, { cwd, timeoutMs, signal: opts.signal, maxOutputBytes: 512 * 1024, shell: opts.shell });
        result = {
          name: spec.name,
          kind: spec.kind,
          command,
          passed: r.exitCode === 0 && !r.timedOut && !r.killed,
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          durationMs: r.durationMs,
          artifacts: [],
          timedOut: r.timedOut,
        };
      } catch (err) {
        result = { name: spec.name, kind: spec.kind, command, passed: false, exitCode: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), durationMs: 0, artifacts: [], timedOut: false };
      } finally {
        await plan.cleanup();
      }
    }
    if (opts.artifactsDir) {
      try {
        await fsp.mkdir(opts.artifactsDir, { recursive: true });
        const safe = spec.name.replace(/[^A-Za-z0-9_-]/g, "_");
        const file = path.join(opts.artifactsDir, `${safe}-${Date.now()}.log`);
        await fsp.writeFile(file, redactString(`# ${command}\n# exit=${result.exitCode} passed=${result.passed} duration=${result.durationMs}ms\n\n## stdout\n${result.stdout}\n\n## stderr\n${result.stderr}\n`));
        result.artifacts.push(file);
      } catch {
        // artifact persistence is best-effort; the result itself is still returned
      }
    }
    await opts.bus?.emit({
      ...base,
      type: result.passed ? "test.passed" : "test.failed",
      durationMs: result.durationMs,
      error: result.passed ? null : `exit=${result.exitCode}${result.timedOut ? " (timeout)" : ""}`,
      data: { name: spec.name, kind: spec.kind, command, exitCode: result.exitCode, stderr: result.stderr.slice(0, 2000), artifacts: result.artifacts },
    });
    return result;
  }

  async runAll(specs: VerificationSpec[], opts: VerifyOptions): Promise<VerificationResult[]> {
    const out: VerificationResult[] = [];
    for (const s of specs) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const result = await this.run(s, opts);
      out.push(result);
      if (opts.failFast && !result.passed) break;
    }
    return out;
  }

  /** Evaluates declarative acceptance checks. Returns one result per check. */
  async runAcceptance(checks: AcceptanceCheck[], opts: VerifyOptions): Promise<AcceptanceResult[]> {
    const results: AcceptanceResult[] = [];
    for (const check of checks) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      try {
        switch (check.type) {
          case "file_exists": {
            const p = resolveSafePath(opts.workdir, check.path ?? "");
            await fsp.access(p);
            results.push({ check, passed: true, detail: `exists: ${check.path}` });
            break;
          }
          case "file_contains":
          case "file_not_contains": {
            const p = resolveSafePath(opts.workdir, check.path ?? "");
            const text = await fsp.readFile(p, "utf8");
            const has = text.includes(check.text ?? "");
            const passed = check.type === "file_contains" ? has : !has;
            results.push({ check, passed, detail: `${check.path} ${has ? "contains" : "does not contain"} ${JSON.stringify(check.text)}` });
            break;
          }
          case "command_succeeds": {
            const r = await this.run({ name: check.description ?? "acceptance", kind: "custom", command: check.command ?? "false" }, { ...opts, bus: null });
            results.push({ check, passed: r.passed, detail: `exit=${r.exitCode} ${r.stderr.slice(0, 300)}` });
            break;
          }
          default:
            results.push({ check, passed: false, detail: `unknown check type ${(check as AcceptanceCheck).type}` });
        }
      } catch (err) {
        results.push({ check, passed: false, detail: err instanceof Error ? err.message : String(err) });
      }
      if (opts.failFast && results.at(-1) && !results.at(-1)!.passed) break;
    }
    return results;
  }
}

function presetFor(kind: Exclude<VerificationKind, "custom">, workdir: string): string {
  if (kind === "unit") {
    try {
      const files = fs.readdirSync(workdir) as string[];
      if (files.includes("pnpm-lock.yaml")) return "pnpm test";
      if (files.includes("yarn.lock")) return "yarn test";
      if (files.includes("bun.lockb") || files.includes("bun.lock")) return "bun test";
    } catch {
      // use npm below
    }
  }
  return VERIFICATION_PRESETS[kind];
}
