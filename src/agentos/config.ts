import fsp from "node:fs/promises";
import { AgentOSError } from "./types";
import { normalizeSandboxConfig, type SandboxConfig } from "./sandbox";
import { PROVIDER_PROFILES, type ProviderProfileId } from "./providers";

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
  /** Required for transport=stdio; ignored for http. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Per-request timeout for JSON-RPC calls (default 30000). */
  timeoutMs?: number;
  /** Transport: "stdio" (default, spawns `command`) or "http" (Streamable HTTP, needs `url`). */
  transport?: "stdio" | "http";
  /** Streamable HTTP endpoint (transport=http). */
  url?: string;
  /** Extra headers for the HTTP transport (e.g. Authorization). */
  headers?: Record<string, string>;
}

export interface LlmConfig {
  /** Provider profile id (sets baseUrl/model/quirk defaults). */
  provider?: ProviderProfileId;
  model?: string;
  baseUrl?: string;
  /** Vault entry name holding the API key (preferred over env vars). */
  apiKeySecret?: string;
  /** Override: server streams tool_calls deltas over SSE (reverse proxies often don't). */
  toolStreaming?: boolean;
  /** Override: server supports response_format json_object. */
  jsonMode?: boolean;
  /** Override: default completion budget for agentic turns. */
  maxTokens?: number;
  /** Override: body field for the completion limit (max_tokens on most endpoints; max_completion_tokens on newer OpenAI). A 400 naming the field auto-flips either way. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}

export interface AgenticConfig {
  /** Execute a turn's multiple tool calls in parallel (default true, limit 4). */
  parallelToolCalls?: boolean;
  /** Max concurrent tool calls within one turn (1..16, default 4). */
  maxParallel?: number;
}

export interface PermissionsConfig {
  /** `tool`, `tool.*` or `tool.action` patterns always allowed (skip confirm prompts). */
  allow?: string[];
  /** Deny wins over allow AND ask: matching calls are rejected without prompting. */
  deny?: string[];
  /** Ask rules force the approval prompt even in auto mode (fail-closed headless). */
  ask?: string[];
}

export interface AgentOsConfig {
  hooks?: Partial<Record<HookEvent, HookConfig[]>>;
  /** MCP servers whose tools are registered into the tool registry at runtime start. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Provider profile + overrides for the LLM endpoint. */
  llm?: LlmConfig;
  /** Sandbox tier for shell commands (terminal tool + verification engine). */
  sandbox?: SandboxConfig;
  /** Agentic loop behaviour. */
  agentic?: AgenticConfig;
  /** Per-tool permission allow/deny table (deny wins; explicit allow skips confirm prompts). */
  permissions?: PermissionsConfig;
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
      const { command, args, env, cwd, timeoutMs, transport: transport_, url, headers } = cfg as Record<string, unknown>;
      if (typeof command !== "string" || !command.trim()) throw new Error(`mcpServers.${name}.command is required`);
      if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) throw new Error(`mcpServers.${name}.args must be an array of strings`);
      if (env !== undefined && (typeof env !== "object" || env === null || Object.entries(env).some(([k, v]) => typeof k !== "string" || typeof v !== "string"))) {
        throw new Error(`mcpServers.${name}.env must be an object of strings`);
      }
      if (cwd !== undefined && typeof cwd !== "string") throw new Error(`mcpServers.${name}.cwd must be a string`);
      if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000)) {
        throw new Error(`mcpServers.${name}.timeoutMs must be a number between 1 and 600000`);
      }
      const transport = transport_ === undefined ? "stdio" : transport_;
      if (transport !== "stdio" && transport !== "http") throw new Error(`mcpServers.${name}.transport must be "stdio" or "http"`);
      if (transport === "stdio" && (typeof command !== "string" || !command.trim())) throw new Error(`mcpServers.${name}.command is required when transport=stdio`);
      if (transport === "http" && (typeof url !== "string" || !/^https?:\/\//.test(url))) throw new Error(`mcpServers.${name}.url must be an http(s) URL when transport=http`);
      if (headers !== undefined && (typeof headers !== "object" || headers === null || Object.entries(headers).some(([k, v]) => typeof k !== "string" || typeof v !== "string"))) {
        throw new Error(`mcpServers.${name}.headers must be an object of strings`);
      }
      servers[name] = { command, args: args as string[] | undefined, env: env as Record<string, string> | undefined, cwd, timeoutMs, transport, url: url as string | undefined, headers: headers as Record<string, string> | undefined };
    }
    out.mcpServers = servers;
  }

  if (src.sandbox !== undefined) {
    try {
      out.sandbox = normalizeSandboxConfig(src.sandbox as Parameters<typeof normalizeSandboxConfig>[0]);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  if (src.llm !== undefined) {
    if (typeof src.llm !== "object" || src.llm === null || Array.isArray(src.llm)) throw new Error("llm must be an object");
    const { provider, model, baseUrl, apiKeySecret, toolStreaming, jsonMode, maxTokens, maxTokensField } = src.llm as Record<string, unknown>;
    if (provider !== undefined && !(typeof provider === "string" && provider in PROVIDER_PROFILES)) {
      throw new Error(`llm.provider must be one of ${Object.keys(PROVIDER_PROFILES).join(", ")}`);
    }
    if (maxTokensField !== undefined && maxTokensField !== "max_tokens" && maxTokensField !== "max_completion_tokens") {
      throw new Error('llm.maxTokensField must be "max_tokens" or "max_completion_tokens"');
    }
    for (const [key, value] of [["model", model], ["baseUrl", baseUrl], ["apiKeySecret", apiKeySecret]] as const) {
      if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error(`llm.${key} must be a non-empty string`);
    }
    for (const [key, value] of [["toolStreaming", toolStreaming], ["jsonMode", jsonMode]] as const) {
      if (value !== undefined && typeof value !== "boolean") throw new Error(`llm.${key} must be a boolean`);
    }
    if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens < 128 || maxTokens > 1_000_000)) {
      throw new Error("llm.maxTokens must be a number between 128 and 1000000");
    }
    out.llm = { provider: provider as ProviderProfileId | undefined, model: model as string | undefined, baseUrl: baseUrl as string | undefined, apiKeySecret: apiKeySecret as string | undefined, toolStreaming: toolStreaming as boolean | undefined, jsonMode: jsonMode as boolean | undefined, maxTokens: maxTokens as number | undefined };
  }

  if (src.permissions !== undefined) {
    if (typeof src.permissions !== "object" || src.permissions === null || Array.isArray(src.permissions)) throw new Error("permissions must be an object");
    const patternRe = /^(\*|[a-zA-Z0-9_-]+(\.\*|\.[a-zA-Z0-9_-]+)?)$/;
    const { allow, deny, ask } = src.permissions as Record<string, unknown>;
    for (const [key, list] of [["allow", allow], ["deny", deny], ["ask", ask]] as const) {
      if (list !== undefined && (!Array.isArray(list) || list.some((p) => typeof p !== "string" || !patternRe.test(p)))) {
        throw new Error(`permissions.${key} must be an array of "*", "tool" or "tool.action" patterns`);
      }
    }
    out.permissions = { allow: allow as string[] | undefined, deny: deny as string[] | undefined, ask: ask as string[] | undefined };
  }

  if (src.agentic !== undefined) {
    if (typeof src.agentic !== "object" || src.agentic === null || Array.isArray(src.agentic)) throw new Error("agentic must be an object");
    const { parallelToolCalls, maxParallel } = src.agentic as Record<string, unknown>;
    if (parallelToolCalls !== undefined && typeof parallelToolCalls !== "boolean") throw new Error("agentic.parallelToolCalls must be a boolean");
    if (maxParallel !== undefined && (typeof maxParallel !== "number" || !Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 16)) throw new Error("agentic.maxParallel must be an integer between 1 and 16");
    out.agentic = { parallelToolCalls: parallelToolCalls as boolean | undefined, maxParallel: maxParallel as number | undefined };
  }

  return out;
}
