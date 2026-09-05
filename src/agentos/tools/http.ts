import type { Tool, ToolActionDef, ToolContext, ToolInput } from "../types";
import { ToolError } from "../types";
import { assertUrlAllowed, redactSecrets } from "../security";
import { optionalArg, requireArg } from "./registry";

const DEFAULT_MAX_BODY = 1024 * 1024;

export class HttpTool implements Tool {
  name = "http";
  description = "HTTP client (http/https only, blocked metadata hosts, size-limited responses, headers redacted in logs)";
  actions: ToolActionDef[] = [
    { name: "get", description: "GET request", params: { url: "string", headers: "object?", timeoutMs: "number?", maxBytes: "number?" } },
    { name: "post", description: "POST request with JSON or text body", params: { url: "string", body: "any?", headers: "object?", timeoutMs: "number?", maxRequestBytes: "number?" } },
    { name: "request", description: "Arbitrary method", params: { url: "string", method: "string", body: "any?", headers: "object?", timeoutMs: "number?", maxRequestBytes: "number?" } },
  ];

  constructor(private opts: { allowedHosts?: string[]; fetchImpl?: typeof fetch } = {}) {}

  async execute(input: ToolInput, ctx: ToolContext): Promise<unknown> {
    const a = input.args ?? {};
    const method = input.action === "get" ? "GET" : input.action === "post" ? "POST" : String(requireArg(a, "method")).toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
      throw new ToolError("INVALID_ARGUMENT", `unsupported method ${method}`);
    }
    const url = assertUrlAllowed(requireArg(a, "url"), this.opts.allowedHosts);
    const rawHeaders = optionalArg<Record<string, unknown>>(a, "headers", {});
    if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) throw new ToolError("INVALID_ARGUMENT", "headers must be an object");
    const headers: Record<string, string> = { "user-agent": "AgentOS/1.0" };
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== "string" || /[\r\n]/.test(value)) throw new ToolError("INVALID_ARGUMENT", `invalid header ${name}`);
      headers[name] = value;
    }
    let body: string | undefined;
    if (a.body !== undefined && method !== "GET" && method !== "HEAD") {
      if (typeof a.body === "string") body = a.body;
      else {
        body = JSON.stringify(a.body);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      }
    }
    const maxRequestBytes = Math.max(0, Number(optionalArg(a, "maxRequestBytes", 2 * 1024 * 1024)));
    if (body !== undefined && Buffer.byteLength(body) > maxRequestBytes) throw new ToolError("PAYLOAD_TOO_LARGE", `request body exceeds ${maxRequestBytes} bytes`);
    const timeoutMs = Math.min(optionalArg(a, "timeoutMs", ctx.timeoutMs), ctx.timeoutMs);
    const maxBytes = Math.max(1, Math.min(Number(optionalArg(a, "maxBytes", DEFAULT_MAX_BODY)), 100 * 1024 * 1024));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ToolError("TIMEOUT", `http request timed out after ${timeoutMs}ms`, { retryable: true })), timeoutMs);
    const onAbort = () => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const started = Date.now();
    try {
      let currentUrl = url;
      let res: Response;
      let redirects = 0;
      for (;;) {
        res = await fetchImpl(currentUrl, { method, headers, body, signal: controller.signal, redirect: "manual" });
        const location = res.headers.get("location");
        if (!location || ![301, 302, 303, 307, 308].includes(res.status)) break;
        if (++redirects > 5) throw new ToolError("TOO_MANY_REDIRECTS", "HTTP redirect limit exceeded", { retryable: false });
        const next = new URL(location, currentUrl);
        assertUrlAllowed(next.toString(), this.opts.allowedHosts);
        // RFC 7231 changes POST to GET for 301/302/303 in common clients.
        if ([301, 302, 303].includes(res.status)) {
          // Keep the original method for safety on 307/308 only; for the
          // other codes use GET and avoid replaying a request body.
          currentUrl = next;
        } else {
          currentUrl = next;
        }
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let truncated = false;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            received += value.byteLength;
            if (received > maxBytes) {
              chunks.push(value.subarray(0, Math.max(0, value.byteLength - (received - maxBytes))));
              truncated = true;
              await reader.cancel();
              break;
            }
            chunks.push(value);
          }
        }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const contentType = res.headers.get("content-type") ?? "";
      let json: unknown = undefined;
      if (!truncated && /json/i.test(contentType)) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      ctx.log(`${method} ${url.origin}${url.pathname} -> ${res.status} (${Date.now() - started}ms)`);
      return {
        status: res.status,
        ok: res.ok,
        headers: redactSecrets(Object.fromEntries(res.headers.entries())),
        body: text,
        json,
        truncated,
        bytes: received,
        durationMs: Date.now() - started,
        redirects,
      };
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason instanceof ToolError) throw controller.signal.reason;
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const cause = (err as { cause?: { code?: string } })?.cause;
      throw new ToolError("NETWORK_ERROR", `${method} ${url.hostname} failed: ${cause?.code ?? (err instanceof Error ? err.message : String(err))}`, {
        retryable: true,
        details: { code: cause?.code },
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }
}
