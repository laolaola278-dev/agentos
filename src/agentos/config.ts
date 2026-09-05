import fsp from "node:fs/promises";
import { AgentOSError } from "./types";

/**
 * `.agentos/config.json` — harness-level extension configuration, modelled on
 * Claude Code's settings.json / .mcp.json split (here merged into one file).
 */
export interface HookConfig {
  /** `tool.action`, `tool.*` or `*` (default). */
  match?: string;
  /** Shell command; a JSON payload describing the event is written to its stdin. */
  command: string;
  timeoutMs?: number;
}

export type HookEvent = "pre_tool_call" | "post_tool_call" | "task_completed" | "task_failed";

export const HOOK_EVENTS: readonly HookEvent[] = ["pre_tool_call", "post_tool_call", "task_completed", "task_failed"];

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Per-request timeout for JSON-RPC calls (default 30000). */
  timeoutMs?: number;
}

export interface AgentOsConfig {
  hooks?: Partial<Record<HookEvent, HookConfig[]>>;
  /** MCP servers whose tools are registered into the tool registry at runtime start. */
  mcpServers?: Record<string, McpServerConfig>;
}

export const CONFIG_FILE = "config.json";

export async function loadAgentOsConfig(dataDir: string): Promise<AgentOsConfig | null> {
  const file = path2(dataDir, CONFIG_FILE);
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    return validateAgentOsConfig(JSON.parse(raw));
  } catch (err) {
    throw new AgentOSError("CONFIG_INVALID", `${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function path2(dir: string, file: string): string {
  // local helper keeps this module free of a path import cycle
  return `${dir.replace(/[\\/]+$/, "")}/${file}`;
}

/** Validates and normalises a config object; unknown fields are ignored. */
export function validateAgentOsConfig(input: unknown): AgentOsConfig {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("config must be a JSON object");
  const src = input as Record<string, unknown>;
  const out: AgentOsConfig = {};

  if (src.hooks !== undefined) {
    if (typeof src.hooks !== "object" || src.hooks === null || Array.isArray(src.hooks)) throw new Error("hooks must be an object keyed by event");
    const hooks: AgentOsConfig["hooks"] = {};
    for (const [event, list] of Object.entries(src.hooks)) {
      if (!HOOK_EVENTS.includes(event as HookEvent)) throw new Error(`unknown hook event "${event}" (expected one of ${HOOK_EVENTS.join(", ")})`);
      if (!Array.isArray(list)) throw new Error(`hooks.${event} must be an array`);
      hooks[event as HookEvent] = list.map((h, i) => {
        if (!h || typeof h !== "object") throw new Error(`hooks.${event}[${i}] must be an object`);
        const { match, command, timeoutMs } = h as Record<string, unknown>;
        if (typeof command !== "string" || !command.trim()) throw new Error(`hooks.${event}[${i}].command is required`);
        if (match !== undefined && (typeof match !== "string" || !/^(\*|[a-zA-Z0-9_-]+(\.\*|\.[a-zA-Z0-9_-]+)?)$/.test(match))) {
          throw new Error(`hooks.${event}[${i}].match must be "*", "tool" or "tool.action"`);
        }
        if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000)) {
          throw new Error(`hooks.${event}[${i}].timeoutMs must be a number between 1 and 600000`);
        }
        return { match: match ?? "*", command, timeoutMs };
      });
    }
    out.hooks = hooks;
  }

  if (src.mcpServers !== undefined) {
    if (typeof src.mcpServers !== "object" || src.mcpServers === null || Array.isArray(src.mcpServers)) throw new Error("mcpServers must be an object keyed by server name");
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(src.mcpServers)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`mcpServers key "${name}" may only contain letters, digits, "_" and "-"`);
      if (!cfg || typeof cfg !== "object") throw new Error(`mcpServers.${name} must be an object`);
      const { command, args, env, cwd, timeoutMs } = cfg as Record<string, unknown>;
      if (typeof command !== "string" || !command.trim()) throw new Error(`mcpServers.${name}.command is required`);
      if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) throw new Error(`mcpServers.${name}.args must be an array of strings`);
      if (env !== undefined && (typeof env !== "object" || env === null || Object.entries(env).some(([k, v]) => typeof k !== "string" || typeof v !== "string"))) {
        throw new Error(`mcpServers.${name}.env must be an object of strings`);
      }
      if (cwd !== undefined && typeof cwd !== "string") throw new Error(`mcpServers.${name}.cwd must be a string`);
      if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000)) {
        throw new Error(`mcpServers.${name}.timeoutMs must be a number between 1 and 600000`);
      }
      servers[name] = { command, args: args as string[] | undefined, env: env as Record<string, string> | undefined, cwd, timeoutMs };
    }
    out.mcpServers = servers;
  }

  return out;
}
