import type { Message, ModelCompletion, ModelProvider } from "./types";
import { AgentOSError } from "./types";
import { redactString } from "./security";

export interface OpenAICompatibleOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  /** Some local/OpenAI-compatible servers do not implement response_format. */
  jsonMode?: boolean;
  fetchImpl?: typeof fetch;
}

/** Minimal OpenAI-compatible chat completion client (works with OpenAI, Azure-compatible proxies, Ollama, vLLM...). */
export class OpenAICompatibleProvider implements ModelProvider {
  name: string;
  constructor(private opts: OpenAICompatibleOptions) {
    this.name = `openai-compatible:${opts.model ?? "gpt-4o-mini"}`;
  }

  async complete(messages: Message[], opts: { json?: boolean; maxTokens?: number; signal?: AbortSignal } = {}): Promise<ModelCompletion> {
    const base = (this.opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new AgentOSError("MODEL_TIMEOUT", `model request timed out after ${this.opts.timeoutMs ?? 120_000}ms`, { retryable: true }));
    }, this.opts.timeoutMs ?? 120_000);
    const onAbort = () => controller.abort(opts.signal?.reason ?? new AgentOSError("MODEL_ABORTED", "model request aborted"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const endpoint = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
      const headers: Record<string, string> = { "content-type": "application/json", ...(this.opts.headers ?? {}) };
      if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
      const body = JSON.stringify({
        model: this.opts.model ?? "gpt-4o-mini",
        messages: messages.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })),
        temperature: 0,
        max_tokens: Math.max(1, Math.min(opts.maxTokens ?? 2048, 1_000_000)),
        ...(opts.json && this.opts.jsonMode !== false ? { response_format: { type: "json_object" } } : {}),
      });
      const maxRetries = Math.max(0, Math.min(this.opts.maxRetries ?? 2, 10));
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await (this.opts.fetchImpl ?? fetch)(endpoint, { method: "POST", headers, body, signal: controller.signal });
        } catch (err) {
          if (controller.signal.aborted) {
            if (opts.signal?.aborted) throw new AgentOSError("MODEL_ABORTED", "model request aborted", { details: opts.signal.reason });
            if (timedOut) throw new AgentOSError("MODEL_TIMEOUT", `model request timed out after ${this.opts.timeoutMs ?? 120_000}ms`, { retryable: true });
          }
          if (attempt < maxRetries) {
            await retryDelay(attempt, controller.signal);
            continue;
          }
          throw err;
        }
        if (!res.ok) {
          const responseText = redactString(await res.text().catch(() => ""));
          const retryable = res.status >= 500 || res.status === 408 || res.status === 409 || res.status === 429;
          if (retryable && attempt < maxRetries) {
            await retryDelay(attempt, controller.signal, res.headers.get("retry-after"));
            continue;
          }
          throw new AgentOSError("MODEL_HTTP_ERROR", `model request failed: ${res.status} ${responseText.slice(0, 500)}`, { retryable, details: { status: res.status } });
        }
        const data = (await res.json()) as { choices?: { message?: { content?: string | { text?: string }[] } }[]; usage?: { total_tokens?: number } };
        const raw = data.choices?.[0]?.message?.content;
        const content = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => part?.text ?? "").join("") : "";
        if (!content.trim()) throw new AgentOSError("MODEL_EMPTY_RESPONSE", "model returned no content", { retryable: true });
        const reported = Number(data.usage?.total_tokens);
        return { content, tokens: Number.isFinite(reported) && reported >= 0 ? reported : Math.ceil(content.length / 4) };
      }
    } catch (err) {
      if (err instanceof AgentOSError) throw err;
      throw new AgentOSError("MODEL_ERROR", redactString(err instanceof Error ? err.message : String(err)), { retryable: true });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Returns a provider when credentials are configured, otherwise null (deterministic mode). */
export function createModelProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider | null {
  const apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY;
  const baseUrl = env.LLM_BASE_URL || env.OPENAI_BASE_URL;
  if (!apiKey && !baseUrl) return null;
  return new OpenAICompatibleProvider({
    apiKey,
    baseUrl,
    model: env.LLM_MODEL || env.OPENAI_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : undefined,
    maxRetries: env.LLM_MAX_RETRIES ? Number(env.LLM_MAX_RETRIES) : undefined,
    jsonMode: env.LLM_JSON_MODE !== "false",
  });
}

/** Extracts the first JSON object/array from a model response. */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  for (let start = 0; start < candidate.length; start++) {
    if (candidate[start] !== "{" && candidate[start] !== "[") continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") stack.push(ch);
      else if (ch === "}" || ch === "]") {
        const expected = ch === "}" ? "{" : "[";
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new AgentOSError("MODEL_BAD_JSON", "no valid JSON object or array found in model output");
}

async function retryDelay(attempt: number, signal: AbortSignal, retryAfter?: string | null): Promise<void> {
  let ms = Math.min(500 * 2 ** attempt, 5000) + Math.floor(Math.random() * 100);
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const dateMs = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(seconds)) ms = Math.min(Math.max(0, seconds * 1000), 30_000);
    else if (Number.isFinite(dateMs)) ms = Math.min(Math.max(0, dateMs), 30_000);
  }
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
