import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AgentOSError } from "./types";

/**
 * Pluggable sandbox tiers for shell commands (terminal tool + verification engine):
 *
 * - `none`      — current behaviour: workspace path guard + deny-list policy.
 * - `process`   — POSIX: ulimit vmem/pid caps layered onto the same shell; on
 *                 Windows process limits are unavailable, so this degrades to `none`.
 * - `container` — runs every command inside an ephemeral Docker container with the
 *                 workspace mounted at /workspace, no network, dropped capabilities,
 *                 memory/cpu/pids caps. Requires a reachable Docker daemon.
 *
 * The sandbox complements the command policy — the deny-list still applies to the
 * wrapped command. This is deliberately not a security boundary against hostile
 * workdirs with `docker` access; it contains accidents, not adversaries (see SECURITY.md).
 */

export type SandboxMode = "none" | "process" | "container";

export interface SandboxConfig {
  mode: SandboxMode;
  /** Container image (container mode). Default `alpine:3` (~3 MB). */
  image?: string;
  /** Memory cap in MB (container + process modes). Default 512. */
  memoryMb?: number;
  /** CPU cap (container mode, fractional ok). Default 1. */
  cpus?: number;
  /** pids cap (container + process modes). Default 256. */
  pidsLimit?: number;
  /** Network access inside the container. Default false. */
  network?: boolean;
  /** When the sandbox backend is unavailable: "fail" (default, secure) or "degrade" to none with a warning. */
  onUnavailable?: "fail" | "degrade";
}

export const DEFAULT_SANDBOX: Required<Omit<SandboxConfig, "image">> & { image: string } = {
  mode: "none",
  image: "alpine:3",
  memoryMb: 512,
  cpus: 1,
  pidsLimit: 256,
  network: false,
  onUnavailable: "fail",
};

/** Validates a partial sandbox config; unknown modes throw. */
export function normalizeSandboxConfig(input: Partial<SandboxConfig> | string | undefined): SandboxConfig {
  const src: Partial<SandboxConfig> = typeof input === "string" ? { mode: input as SandboxMode } : { ...(input ?? {}) };
  const cfg = { ...DEFAULT_SANDBOX, ...src } as SandboxConfig;
  if (!["none", "process", "container"].includes(cfg.mode)) throw new AgentOSError("CONFIG_INVALID", `sandbox.mode must be none|process|container, got "${cfg.mode}"`);
  if (!Number.isFinite(cfg.memoryMb) || (cfg.memoryMb as number) < 32 || (cfg.memoryMb as number) > 65_536) throw new AgentOSError("CONFIG_INVALID", "sandbox.memoryMb must be 32..65536");
  if (!Number.isFinite(cfg.cpus) || (cfg.cpus as number) <= 0 || (cfg.cpus as number) > 64) throw new AgentOSError("CONFIG_INVALID", "sandbox.cpus must be >0 and <=64");
  if (!Number.isFinite(cfg.pidsLimit) || (cfg.pidsLimit as number) < 16 || (cfg.pidsLimit as number) > 4096) throw new AgentOSError("CONFIG_INVALID", "sandbox.pidsLimit must be 16..4096");
  if (cfg.image !== undefined && (typeof cfg.image !== "string" || !/^[a-zA-Z0-9._:/-]+$/.test(cfg.image))) throw new AgentOSError("CONFIG_INVALID", `sandbox.image looks invalid: ${cfg.image}`);
  return cfg;
}

let daemonProbe: Promise<boolean> | null = null;

/** Checks that the Docker daemon is reachable (cached for the process lifetime). */
export function dockerDaemonAvailable(probe: () => Promise<boolean> = defaultDockerProbe): Promise<boolean> {
  if (!daemonProbe) daemonProbe = probe().catch(() => false);
  return daemonProbe;
}

/** Test hook to reset the cached daemon probe. */
export function resetDaemonProbe(): void {
  daemonProbe = null;
}

async function defaultDockerProbe(): Promise<boolean> {
  const { runCommand } = await import("./tools/terminal");
  const r = await runCommand("docker info --format {{.ServerVersion}}", { cwd: process.cwd(), timeoutMs: 10_000 });
  return r.exitCode === 0 && r.stdout.trim().length > 0;
}

export interface SandboxPlan {
  /** The command to actually execute through the shell. */
  command: string;
  /** Removes temp artifacts (sandbox script) after the run. */
  cleanup: () => Promise<void>;
  mode: SandboxMode;
  /** Set when the requested mode could not be applied and the command degraded. */
  note?: string;
}

/**
 * Builds the sandboxed form of a command.
 * - container: writes the command into `<workdir>/.agentos-sandbox/run-<rand>.sh`
 *   (the workspace is mounted, so stdin stays available) and returns a
 *   `docker run …` invocation; `cleanup()` deletes the script.
 * - process (POSIX): prefixes ulimit vmem/pid caps. Windows degrades to none.
 */
export async function planSandboxedCommand(command: string, opts: { workdir: string; cfg: SandboxConfig; available?: () => Promise<boolean> }): Promise<SandboxPlan> {
  const cfg = normalizeSandboxConfig(opts.cfg);
  const noop: SandboxPlan = { command, cleanup: async () => undefined, mode: "none" };
  if (cfg.mode === "none") return noop;

  if (cfg.mode === "process") {
    if (process.platform === "win32") {
      return { ...noop, note: "process limits are unsupported on win32; ran unsandboxed" };
    }
    const caps = [`ulimit -v ${Math.round((cfg.memoryMb ?? DEFAULT_SANDBOX.memoryMb) * 1024)} 2>/dev/null`, `ulimit -u ${cfg.pidsLimit ?? DEFAULT_SANDBOX.pidsLimit} 2>/dev/null`].join("; ");
    return { command: `${caps}; ${command}`, cleanup: async () => undefined, mode: "process" };
  }

  // container mode
  const available = opts.available ?? (() => dockerDaemonAvailable());
  if (!(await available())) {
    if (cfg.onUnavailable === "degrade") return { ...noop, note: "docker daemon unavailable; ran unsandboxed (sandbox.onUnavailable=degrade)" };
    throw new AgentOSError("SANDBOX_UNAVAILABLE", "sandbox mode=container requires a reachable Docker daemon (start Docker Desktop or set sandbox.onUnavailable=degrade)");
  }
  const dir = path.join(opts.workdir, ".agentos-sandbox");
  await fsp.mkdir(dir, { recursive: true });
  const script = path.join(dir, `run-${randomBytes(6).toString("hex")}.sh`);
  await fsp.writeFile(script, `cd /workspace\n${command}\n`, "utf8");
  const workdirSpec = `${opts.workdir.replace(/\\/g, "/")}:/workspace`;
  const parts = [
    "MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXC='*' docker run --rm",
    cfg.network === false ? "--network none" : "",
    `--memory ${cfg.memoryMb}m`,
    `--cpus ${cfg.cpus}`,
    `--pids-limit ${cfg.pidsLimit}`,
    "--cap-drop ALL --security-opt no-new-privileges",
    `-e AGENTOS_SANDBOXED=1`,
    `-v "${workdirSpec}"`,
    "-w /workspace",
    cfg.image,
    "bash /workspace/.agentos-sandbox/" + path.basename(script),
  ].filter(Boolean);
  return {
    command: parts.join(" "),
    cleanup: async () => {
      await fsp.rm(script, { force: true }).catch(() => undefined);
    },
    mode: "container",
  };
}
