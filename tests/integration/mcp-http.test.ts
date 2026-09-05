import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { AgentRuntime } from "@/agentos/runtime";
import { tmpDir, rmRetry } from "../helpers";

/** Minimal MCP Streamable-HTTP server: initialize → tools/list → tools/call (JSON + SSE responses). */
function startMcpHttpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}") as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const reply = (result: unknown, asSse = false) => {
        if (msg.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
        if (asSse) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`event: message\ndata: ${payload}\n\n`);
        } else {
          res.writeHead(200, { "content-type": "application/json", ...(req.headers["mcp-session-id"] ? {} : { "mcp-session-id": "sess-123" }) });
          res.end(payload);
        }
      };
      switch (msg.method) {
        case "initialize":
          reply({ protocolVersion: "2024-11-05", serverInfo: { name: "http-mcp", version: "0.2.0" } });
          break;
        case "notifications/initialized":
          reply(undefined as never);
          break;
        case "tools/list":
          reply({ tools: [{ name: "shout", description: "Uppercase the text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
          break;
        case "tools/call":
          if (msg.params?.name === "shout") {
            const text = String((msg.params.arguments as { text?: string }).text ?? "");
            reply({ content: [{ type: "text", text: `SHOUT: ${text.toUpperCase()}` }] }, true); // SSE response path
          } else {
            reply({ content: [{ type: "text", text: "unknown tool" }], isError: true }, true);
          }
          break;
        default:
          reply({ error: { code: -32601, message: "method not found" } });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/mcp`, close: () => new Promise((r) => server.close(() => r(undefined as never))) });
    });
  });
}

test("MCP Streamable HTTP transport registers tools and routes calls (JSON + SSE)", async () => {
  const server = await startMcpHttpServer();
  const dir = await tmpDir("agentos-mcp-http-");
  const rt = await AgentRuntime.create({
    rootDir: dir,
    dataDir: path.join(dir, ".agentos"),
    persistence: "memory",
    model: null,
    controlPollMs: 0,
    config: { mcpServers: { web: { transport: "http", url: server.url } } },
  });
  try {
    assert.ok(rt.tools.get("mcp_web_shout"), "http MCP tool registered");
    const task = await rt.createTask({
      title: "http mcp",
      goal: "n/a",
      steps: [{ id: "s1", tool: "mcp_web_shout", action: "call", args: { text: "hello mcp" } }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", done.error);
    const step = done.result?.stepResults.find((r) => r.stepId === "s1");
    assert.match(JSON.stringify(step?.output?.data), /SHOUT: HELLO MCP/, "tool call round-tripped over HTTP (SSE response parsed)");
  } finally {
    await rt.close();
    await server.close();
    await rmRetry(dir);
  }
});

test("MCP http transport validation: url required", async () => {
  const dir = await tmpDir("agentos-mcp-http2-");
  const rt = await AgentRuntime.create({
    rootDir: dir,
    dataDir: path.join(dir, ".agentos"),
    persistence: "memory",
    model: null,
    controlPollMs: 0,
    config: { mcpServers: { broken: { transport: "http" } } },
  });
  try {
    const events = await rt.bus.query({ typePrefix: "mcp." });
    assert.ok(events.some((e) => e.type === "mcp.failed"), "misconfigured http server fails gracefully via mcp.failed");
  } finally {
    await rt.close();
    await rmRetry(dir);
  }
  void fsp;
});
