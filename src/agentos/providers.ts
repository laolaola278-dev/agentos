import type { AgentOsConfig } from "./config";
import type { SecretVault } from "./secrets";
import { OpenAICompatibleProvider } from "./model";

/**
 * Provider profiles — preconfigured adapters for OpenAI-compatible endpoints with
 * their compatibility quirks ("cracked" behaviours) in one place: GitHub Models as a
 * hosted gateway, DeepSeek, GLM, local Ollama, and arbitrary reverse proxies.
 *
 * A profile only sets defaults (baseUrl, model, key env names, quirk flags);
 * explicit `config.llm` values always win. This layer adapts to provider quirks —
 * it deliberately does not (and will not) bypass payment, auth or rate limits.
 */

export type ProviderProfileId = "openai" | "github-models" | "deepseek" | "glm" | "ollama" | "custom";

export interface ProviderProfile {
  id: ProviderProfileId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  /** Env var candidates for the API key, in order. */
  apiKeyEnv: string[];
  /** Default vault entry name for this provider's key. */
  defaultSecretName: string;
  /** Server supports `response_format: json_object`. */
  jsonMode: boolean;
  /** Server streams tool_calls deltas correctly over SSE. Reverse proxies often don't. */
  toolStreaming: boolean;
  /** Default completion budget for agentic turns. */
  maxTokens: number;
  /** Body field carrying the completion limit (older endpoints: max_tokens; newer OpenAI: max_completion_tokens). */
  maxTokensField: "max_tokens" | "max_completion_tokens";
}

export const PROVIDER_PROFILES: Record<ProviderProfileId, ProviderProfile> = {
  openai: {
    id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini",
    apiKeyEnv: ["LLM_API_KEY", "OPENAI_API_KEY"], defaultSecretName: "LLM_API_KEY",
    jsonMode: true, toolStreaming: true, maxTokens: 8192,
  maxTokensField: "max_tokens",
  },
  "github-models": {
    id: "github-models", label: "GitHub Models (hosted gateway)", baseUrl: "https://models.github.ai/inference", defaultModel: "openai/gpt-4o-mini",
    apiKeyEnv: ["GITHUB_TOKEN", "GH_TOKEN"], defaultSecretName: "GITHUB_TOKEN",
    jsonMode: true, toolStreaming: true, maxTokens: 8192,
  maxTokensField: "max_tokens",
  },
  deepseek: {
    id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat",
    apiKeyEnv: ["DEEPSEEK_API_KEY", "LLM_API_KEY"], defaultSecretName: "DEEPSEEK_API_KEY",
    jsonMode: true, toolStreaming: false, maxTokens: 8192,
  maxTokensField: "max_tokens",
  },
  glm: {
    id: "glm", label: "Zhipu GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-flash",
    apiKeyEnv: ["GLM_API_KEY", "ZHIPU_API_KEY", "LLM_API_KEY"], defaultSecretName: "GLM_API_KEY",
    jsonMode: true, toolStreaming: false, maxTokens: 8192,
  maxTokensField: "max_tokens",
  },
  ollama: {
    id: "ollama", label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "qwen2.5-coder:7b",
    apiKeyEnv: [], defaultSecretName: "OLLAMA_API_KEY",
    jsonMode: false, toolStreaming: false, maxTokens: 8192,
  maxTokensField: "max_tokens",
  },
  custom: {
    id: "custom", label: "Custom / reverse proxy", baseUrl: "", defaultModel: "",
    apiKeyEnv: ["LLM_API_KEY"], defaultSecretName: "LLM_API_KEY",
    jsonMode: false, toolStreaming: false, maxTokens: 8192,
  maxTokensField: "max_tokens",
  },
};

export interface ProviderSettingsInput {
  env: NodeJS.ProcessEnv;
  vault?: SecretVault | null;
  llm?: AgentOsConfig["llm"];
}

export interface ResolvedProviderSettings {
  profile: ProviderProfile;
  baseUrl: string;
  model: string;
  apiKey?: string;
  quirks: { toolStreaming: boolean; jsonMode: boolean; maxTokens: number; maxTokensField: "max_tokens" | "max_completion_tokens" };
  /** Where the key came from (for doctor / audit; never the value). */
  keySource: "env" | "vault" | "none";
}

function isProfileId(v: unknown): v is ProviderProfileId {
  return typeof v === "string" && v in PROVIDER_PROFILES;
}

/** Resolves provider settings from config.llm → env → vault. Returns null in deterministic mode (no key). */
export async function resolveProviderSettings(input: ProviderSettingsInput): Promise<ResolvedProviderSettings | null> {
  const llm = input.llm ?? {};
  const profileId: ProviderProfileId = isProfileId(llm.provider) ? llm.provider : isProfileId(input.env.LLM_PROVIDER) ? input.env.LLM_PROVIDER : "openai";
  const profile = PROVIDER_PROFILES[profileId];

  const baseUrl = llm.baseUrl ?? input.env.LLM_BASE_URL ?? input.env.OPENAI_BASE_URL ?? profile.baseUrl;
  const model = llm.model ?? input.env.LLM_MODEL ?? input.env.OPENAI_MODEL ?? profile.defaultModel;
  if (!baseUrl) return null;

  // key precedence: named vault entry → provider env vars → vault default entry
  let apiKey: string | undefined;
  let keySource: ResolvedProviderSettings["keySource"] = "none";
  if (llm.apiKeySecret && input.vault) {
    apiKey = (await input.vault.get(llm.apiKeySecret)) ?? undefined;
    if (apiKey) keySource = "vault";
  }
  if (!apiKey) {
    for (const envName of profile.apiKeyEnv) {
      if (input.env[envName]) {
        apiKey = input.env[envName];
        keySource = "env";
        break;
      }
    }
  }
  if (!apiKey && input.vault) {
    apiKey = (await input.vault.get(profile.defaultSecretName)) ?? undefined;
    if (apiKey) keySource = "vault";
  }
  // legacy fallbacks keep pre-profile behaviour working (LLM_API_KEY in vault)
  if (!apiKey && input.vault && profileId === "openai") {
    apiKey = (await input.vault.get("LLM_API_KEY")) ?? undefined;
    if (apiKey) keySource = "vault";
  }
  // keyless profiles (local runtimes like ollama) need no credential at all
  if (!apiKey && profile.apiKeyEnv.length > 0) return null;

  return {
    profile,
    baseUrl,
    model,
    apiKey,
    keySource,
    quirks: {
      toolStreaming: llm.toolStreaming ?? profile.toolStreaming,
      jsonMode: llm.jsonMode ?? profile.jsonMode,
      maxTokens: llm.maxTokens ?? profile.maxTokens,
      maxTokensField: llm.maxTokensField ?? profile.maxTokensField,
    },
  };
}

/** Builds the runtime provider from resolved settings (quirks attached for the agentic loop). */
export function createProviderFromSettings(settings: ResolvedProviderSettings, overrides: { fetchImpl?: typeof fetch; timeoutMs?: number; maxRetries?: number } = {}): import("./types").ModelProvider {
  const provider = new OpenAICompatibleProvider({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    jsonMode: settings.quirks.jsonMode,
    maxTokensField: settings.quirks.maxTokensField,
    timeoutMs: overrides.timeoutMs,
    maxRetries: overrides.maxRetries,
    fetchImpl: overrides.fetchImpl,
  });
  (provider as OpenAICompatibleProvider & { quirks?: unknown }).quirks = settings.quirks;
  return provider;
}
