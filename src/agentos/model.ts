import type { Message, ModelCompletion, ModelProvider, ModelStreamEvent, ModelToolCompletion, ToolCallRequest, ToolSchema } from "./types";
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

type ApiMessage = Record<string, unknown>;

/** Maps harness messages to the OpenAI wire format. Text-only providers get tool traffic flattened into user turns. */
function toApiMessages(messages: Message[], opts: { nativeTools: boolean }): ApiMessage[] {
  return messages.map((m) => {
    if (opts.nativeTools) {
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: m.content,
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
        };
      }
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
      }
      return { role: m.role, content: m.content };
    }
    // text-only fallback: tool results become user turns, tool-call requests become readable text
    if (m.role === "assistant" && m.toolCalls?.length) {
      const calls = m.toolCalls.map((c) => `[calls ${c.name}(${c.arguments})]`).join(" ");
      return { role: "assistant", content: `${m.content} ${calls}`.trim() };
    }
    if (m.role === "tool") return { role: "user", content: `[${m.name ?? "tool"} result] ${m.content}` };
    return { role: m.role, content: m.content };
  });
}

function parseContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((part) => (part as { text?: string })?.text ?? "").join("");
  return "";
}

function parseToolCalls(raw: unknown): ToolCallRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c, i) => {
      const fn = (c.function ?? {}) as { name?: unknown; arguments?: unknown };
      return {
        id: typeof c.id === "string" && c.id ? c.id : `call_${i}`,
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : fn.arguments == null ? "{}" : JSON.stringify(fn.arguments),
      };
    })
    .filter((c) => c.name);
}

interface ChatResponse {
  choices?: {
    message?: { content?: unknown; tool_calls?: unknown };
    delta?: { content?: unknown; tool_calls?: unknown };
    finish_reason?: string;
  }[];
  usage?: { total_tokens?: number };
}

/** Minimal OpenAI-compatible chat completion client (works with OpenAI, DeepSeek, GLM, Ollama, vLLM...). */
export class OpenAICompatibleProvider implements ModelProvider {
  name: string;
  constructor(private opts: OpenAICompatibleOptions) {
    this.name = `openai-compatible:${opts.model ?? "gpt-4o-mini"}`;
  }

  private model(): string {
    return this.opts.model ?? "gpt-4o-mini";
  }

  /** Single request pipeline shared by complete/completeWithTools/stream: timeout, abort, retry, redaction. */
  private async chat(body: Record<string, unknown>, opts: { signal?: AbortSignal; stream?: boolean } = {}): Promise<Response> {
    const base = (this.opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new AgentOSError("MODEL_TIMEOUT", `model request timed out after ${this.opts.timeoutMs ?? 120_000}ms`, { retryable: true }));
    }, this.opts.timeoutMs ?? 120_000);
    const onAbort = () => controller.abort(opts.signal?.reason ?? new AgentOSError("MODEL_ABORTED", "model request aborted"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const endpoint = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json", ...(this.opts.headers ?? {}) };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const maxRetries = Math.max(0, Math.min(this.opts.maxRetries ?? 2, 10));
    try {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await (this.opts.fetchImpl ?? fetch)(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
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
        return res;
      }
    } catch (err) {
      if (err instanceof AgentOSError) throw err;
      throw new AgentOSError("MODEL_ERROR", redactString(err instanceof Error ? err.message : String(err)), { retryable: true });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async complete(messages: Message[], opts: { json?: boolean; maxTokens?: number; signal?: AbortSignal } = {}): Promise<ModelCompletion> {
    const body: Record<string, unknown> = {
      model: this.model(),
      messages: toApiMessages(messages, { nativeTools: false }),
      temperature: 0,
      max_tokens: Math.max(1, Math.min(opts.maxTokens ?? 2048, 1_000_000)),
      ...(opts.json && this.opts.jsonMode !== false ? { response_format: { type: "json_object" } } : {}),
    };
    const res = await this.chat(body, { signal: opts.signal });
    const data = (await res.json()) as ChatResponse;
    const content = parseContent(data.choices?.[0]?.message?.content);
    if (!content.trim()) throw new AgentOSError("MODEL_EMPTY_RESPONSE", "model returned no content", { retryable: true });
    const reported = Number(data.usage?.total_tokens);
    return { content, tokens: Number.isFinite(reported) && reported >= 0 ? reported : Math.ceil(content.length / 4) };
  }

  async completeWithTools(messages: Message[], tools: ToolSchema[], opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<ModelToolCompletion> {
    const body: Record<string, unknown> = {
      model: this.model(),
      messages: toApiMessages(messages, { nativeTools: true }),
      temperature: 0,
      max_tokens: Math.max(1, Math.min(opts.maxTokens ?? 4096, 1_000_000)),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
    };
    const res = await this.chat(body, { signal: opts.signal });
    const data = (await res.json()) as ChatResponse;
    const message = data.choices?.[0]?.message;
    const toolCalls = parseToolCalls(message?.tool_calls);
    const content = parseContent(message?.content);
    const reported = Number(data.usage?.total_tokens);
    return {
      content,
      toolCalls,
      tokens: Number.isFinite(reported) && reported >= 0 ? reported : Math.ceil((content.length + toolCalls.reduce((n, c) => n + c.arguments.length, 0)) / 4),
      finishReason: data.choices?.[0]?.finish_reason,
    };
  }

  /**
   * SSE streaming: yields text deltas as they arrive and a final completion with
   * accumulated tool calls (when `tools` was provided).
   */
  async *stream(messages: Message[], opts: { tools?: ToolSchema[]; maxTokens?: number; signal?: AbortSignal } = {}): AsyncGenerator<ModelStreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model(),
      messages: toApiMessages(messages, { nativeTools: !!opts.tools?.length }),
      temperature: 0,
      max_tokens: Math.max(1, Math.min(opts.maxTokens ?? 2048, 1_000_000)),
      stream: true,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }
    const res = await this.chat(body, { signal: opts.signal, stream: true });
    if (!res.body) throw new AgentOSError("MODEL_ERROR", "model response has no body", { retryable: true });
    let content = "";
    let finishReason: string | undefined;
    let tokens = 0;
    // tool_calls arrive as fragments across chunks, keyed by their `index`
    const toolAcc = new Map<number, { id?: string; name?: string; args: string }>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk: ChatResponse;
          try {
            chunk = JSON.parse(payload) as ChatResponse;
          } catch {
            continue; // keep-alive comments / partial lines
          }
          const choice = chunk.choices?.[0];
          const delta = parseContent(choice?.delta?.content);
          if (delta) {
            content += delta;
            yield { delta };
          }
          if (Array.isArray(choice?.delta?.tool_calls)) {
            for (const frag of choice!.delta!.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
              const idx = typeof frag.index === "number" ? frag.index : 0;
              const acc = toolAcc.get(idx) ?? { args: "" };
              if (frag.id) acc.id = frag.id;
              if (frag.function?.name) acc.name = (acc.name ?? "") + frag.function.name;
              if (frag.function?.arguments) acc.args += frag.function.arguments;
              toolAcc.set(idx, acc);
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const reported = Number(chunk.usage?.total_tokens);
          if (Number.isFinite(reported) && reported > 0) tokens = reported;
        }
      }
    } finally {
      reader.releaseLock();
    }
    const toolCalls = parseToolCalls(
      [...toolAcc.entries()].sort(([a], [b]) => a - b).map(([, acc]) => ({ id: acc.id, function: { name: acc.name, arguments: acc.args } })),
    );
    yield { completion: { content, toolCalls, tokens: tokens || Math.ceil((content.length + toolCalls.reduce((n, c) => n + c.arguments.length, 0)) / 4), finishReason: finishReason ?? (toolCalls.length ? "tool_calls" : "stop") } };
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
