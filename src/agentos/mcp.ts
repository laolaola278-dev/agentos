import { spawn, type ChildProcess } from "node:child_process";
import type { Tool } from "./types";
import { ToolError } from "./types";
import type { ToolRegistry } from "./tools/registry";
import { buildSafeEnv } from "./security";
import type { McpServerConfig } from "./config";

/**
 * Minimal MCP (Model Context Protocol) stdio client — the same integration point
 * Claude Code / Codex use for external tools. Speaks newline-delimited JSON-RPC 2.0:
 * initialize → notifications/initialized → tools/list → tools/call.
 */

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private stderrTail = "";
  private stderrHead: ((chunk: string) => void) | null = null;
  private exitPromise: Promise<void> | null = null;

  constructor(
    readonly serverName: string,
    private cfg: McpServerConfig,
  ) {}

  serverInfo: { name?: string; version?: string; protocolVersion?: string } = {};

  private spawnServer(): ChildProcess {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.cfg.cwd,
      env: buildSafeEnv(this.cfg.env ?? {}) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      this.stderrHead?.(chunk);
    });
    child.on("error", (err) => this.failAll(new ToolError("MCP_SERVER_ERROR", `server "${this.serverName}" failed to start: ${err.message}`, { details: this.stderrTail })));
    child.on("exit", (code, signal) => {
      this.failAll(new ToolError("MCP_SERVER_EXIT", `server "${this.serverName}" exited (code=${code} signal=${signal})${this.stderrTail ? `: ${this.stderrTail.slice(-500)}` : ""}`));
    });
    this.exitPromise = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // keep-alive or malformed line
      }
      if (typeof msg.id !== "number" || !this.pending.has(msg.id)) continue; // notification
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new ToolError("MCP_ERROR", `MCP error ${msg.error.code ?? ""}: ${msg.error.message ?? "unknown"}`));
      else p.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number, notification = false): Promise<unknown> {
    if (!this.child) throw new ToolError("MCP_NOT_CONNECTED", `server "${this.serverName}" is not connected`);
    if (notification) {
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
      return Promise.resolve(undefined);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError("MCP_TIMEOUT", `MCP request ${method} on "${this.serverName}" timed out after ${timeoutMs}ms`, { retryable: true }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** Spawns the server and performs the MCP initialize handshake. */
  async connect(timeoutMs?: number): Promise<void> {
    if (this.child) return;
    const t = timeoutMs ?? this.cfg.timeoutMs ?? 30_000;
    this.child = this.spawnServer();
    try {
      const result = (await this.request(
        "initialize",
        { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agentos", version: "1.0.0" } },
        t,
      )) as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string };
      this.serverInfo = { ...(result?.serverInfo ?? {}), protocolVersion: result?.protocolVersion };
      await this.request("notifications/initialized", {}, t, true);
    } catch (err) {
      this.close();
      throw err;
    }
  }

  async listTools(timeoutMs?: number): Promise<McpToolDef[]> {
    const t = timeoutMs ?? this.cfg.timeoutMs ?? 30_000;
    const tools: McpToolDef[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.request("tools/list", cursor ? { cursor } : {}, t)) as { tools?: McpToolDef[]; nextCursor?: string };
      tools.push(...(result?.tools ?? []).filter((tool) => tool && typeof tool.name === "string"));
      cursor = result?.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Calls an MCP tool; text content parts are joined. Throws on isError responses. */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ content: string; isError: boolean }> {
    const t = timeoutMs ?? this.cfg.timeoutMs ?? 30_000;
    const result = (await this.request("tools/call", { name, arguments: args }, t)) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const content = (result?.content ?? [])
      .filter((c) => !c?.type || c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    if (result?.isError) throw new ToolError("MCP_TOOL_ERROR", content.slice(0, 2000) || `tool ${name} reported an error`);
    return { content, isError: false };
  }

  /** Kills the server process and resolves once it exited (bounded by 3s), so callers can clean up safely. */
  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.failAll(new ToolError("MCP_CLOSED", `server "${this.serverName}" connection closed`));
    if (child.exitCode === null && !child.signalCode) {
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1500);
      force.unref();
    }
    await Promise.race([this.exitPromise ?? Promise.resolve(), new Promise<void>((r) => setTimeout(r, 3000).unref())]);
  }
}

/** Maps a JSON-schema input definition to the registry's `name: type?` param descriptors. */
export function paramsFromSchema(schema: unknown): Record<string, string> {
  const properties = (schema as { properties?: Record<string, unknown> })?.properties ?? {};
  const required = new Set(((schema as { required?: unknown })?.required as string[] | undefined) ?? []);
  const out: Record<string, string> = {};
  for (const [key, def] of Object.entries(properties)) {
    const t = (def as { type?: string })?.type;
    const base = t === "number" || t === "integer" ? "number" : t === "boolean" ? "boolean" : t === "array" ? "string[]" : t === "object" ? "object" : t === "string" ? "string" : "any";
    out[key] = required.has(key) ? base : `${base}?`;
  }
  return out;
}

export function mcpToolRegistryName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export interface McpRegistration {
  server: string;
  registeredTools: string[];
}

/**
 * Connects every configured MCP server, lists its tools and registers one
 * registry tool per MCP tool (single `call` action, args passed through —
 * the MCP server performs its own validation).
 */
export async function registerMcpTools(
  registry: ToolRegistry,
  servers: Record<string, McpServerConfig>,
  opts: { onClient?: (name: string, client: McpClient) => void; connectTimeoutMs?: number } = {},
): Promise<McpRegistration[]> {
  const registrations: McpRegistration[] = [];
  for (const [serverName, cfg] of Object.entries(servers)) {
    const client = new McpClient(serverName, cfg);
    try {
      await client.connect(opts.connectTimeoutMs);
      const tools = await client.listTools();
      const registeredTools: string[] = [];
      for (const tool of tools) {
        const name = mcpToolRegistryName(serverName, tool.name);
        registry.register({
          name,
          description: tool.description?.trim() || `MCP tool "${tool.name}" on server "${serverName}"`,
          actions: [
            {
              name: "call",
              description: `Call MCP tool "${tool.name}" on server "${serverName}"`,
              params: paramsFromSchema(tool.inputSchema),
            },
          ],
          async execute(input) {
            if (input.action !== "call") throw new ToolError("UNKNOWN_ACTION", `unknown action ${name}.${input.action}`);
            const res = await client.callTool(tool.name, input.args ?? {});
            return { server: serverName, tool: tool.name, content: res.content };
          },
        });
        registeredTools.push(name);
      }
      opts.onClient?.(serverName, client);
      registrations.push({ server: serverName, registeredTools });
    } catch (err) {
      client.close();
      throw err instanceof ToolError ? err : new ToolError("MCP_CONNECT_FAILED", `failed to connect MCP server "${serverName}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return registrations;
}
