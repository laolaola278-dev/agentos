import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider, extractJson } from "@/agentos/model";
import { toolSchemasFromRegistry, trimConversation } from "@/agentos/agents";
import { hookMatches } from "@/agentos/hooks";
import { paramsFromSchema, mcpToolRegistryName } from "@/agentos/mcp";
import { createDefaultToolRegistry } from "@/agentos/tools";
import type { Message } from "@/agentos/types";
import { toolCall } from "../helpers";

function fetchJson(payload: unknown, statuses?: number[]): typeof fetch {
  const calls: RequestInit[] = [];
  let n = 0;
  const fn = (async (_url: string | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    const status = statuses && n < statuses.length ? statuses[n] : 200;
    n++;
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  (fn as typeof fetch & { calls: RequestInit[] }).calls = calls;
  return fn;
}

test("complete parses content and tokens, retries on 500", async () => {
  const payload = { choices: [{ message: { content: "hello world" } }], usage: { total_tokens: 7 } };
  const fetchImpl = fetchJson(payload, [500, 200]) as typeof fetch & { calls: RequestInit[] };
  const p = new OpenAICompatibleProvider({ apiKey: "sk-test", baseUrl: "https://api.test/v1", fetchImpl, maxRetries: 2 });
  const res = await p.complete([{ role: "user", content: "hi", ts: "t" }]);
  assert.equal(res.content, "hello world");
  assert.equal(res.tokens, 7);
  assert.equal(fetchImpl.calls.length, 2, "one retry after 500");
  const body = JSON.parse(String(fetchImpl.calls[0].body)) as { messages: { role: string }[] };
  assert.equal(body.messages[0].role, "user");
});

test("complete flattens tool messages for text-only endpoints", async () => {
  const fetchImpl = fetchJson({ choices: [{ message: { content: "ok" } }] }) as typeof fetch & { calls: RequestInit[] };
  const p = new OpenAICompatibleProvider({ fetchImpl });
  const messages: Message[] = [
    { role: "assistant", content: "", ts: "t", toolCalls: [{ id: "c1", name: "filesystem__write", arguments: '{"path":"a"}' }] },
    { role: "tool", content: '{"ok":true}', ts: "t", toolCallId: "c1", name: "filesystem__write" },
  ];
  await p.complete(messages);
  const body = JSON.parse(String(fetchImpl.calls[0].body)) as { messages: { role: string; content: string }[] };
  assert.equal(body.messages[0].role, "assistant");
  assert.match(body.messages[0].content, /filesystem__write/);
  assert.equal(body.messages[1].role, "user", "tool results become user turns");
  assert.match(body.messages[1].content, /\[filesystem__write result\]/);
});

test("completeWithTools sends tool schemas and parses tool_calls", async () => {
  const payload = {
    choices: [{ message: { content: "thinking", tool_calls: [{ id: "call_1", type: "function", function: { name: "filesystem__write", arguments: '{"path":"a.txt"}' } }, { id: "call_2", type: "function", function: { name: "terminal__execute" } }] }, finish_reason: "tool_calls" }],
    usage: { total_tokens: 42 },
  };
  const fetchImpl = fetchJson(payload) as typeof fetch & { calls: RequestInit[] };
  const p = new OpenAICompatibleProvider({ fetchImpl });
  const res = await p.completeWithTools([{ role: "user", content: "go", ts: "t" }], [{ name: "filesystem__write", description: "write", parameters: { type: "object" } }]);
  assert.equal(res.toolCalls.length, 2);
  assert.deepEqual(res.toolCalls[0], { id: "call_1", name: "filesystem__write", arguments: '{"path":"a.txt"}' });
  assert.equal(res.toolCalls[1].arguments, "{}", "missing arguments default to empty object");
  assert.equal(res.tokens, 42);
  assert.equal(res.finishReason, "tool_calls");
  const body = JSON.parse(String(fetchImpl.calls[0].body)) as { tools: { type: string; function: { name: string } }[]; tool_choice: string; messages: { role: string; content: string }[] };
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "filesystem__write");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.messages[0].role, "user");
});

test("completeWithTools keeps native tool message roles", async () => {
  const fetchImpl = fetchJson({ choices: [{ message: { content: "done", tool_calls: [] } }] }) as typeof fetch & { calls: RequestInit[] };
  const p = new OpenAICompatibleProvider({ fetchImpl });
  const messages: Message[] = [
    { role: "assistant", content: "", ts: "t", toolCalls: [toolCall("filesystem__read", { path: "a" }, "c9")] },
    { role: "tool", content: '{"ok":true}', ts: "t", toolCallId: "c9", name: "filesystem__read" },
  ];
  await p.completeWithTools(messages, []);
  const body = JSON.parse(String(fetchImpl.calls[0].body)) as { messages: Record<string, unknown>[] };
  assert.deepEqual(body.messages[0].tool_calls, [{ id: "c9", type: "function", function: { name: "filesystem__read", arguments: '{"path":"a"}' } }]);
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "c9");
});

test("stream yields SSE text deltas and a final completion", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"he"}}]}',
    ": keep-alive comment",
    "data: not-json",
    'data: {"choices":[{"delta":{"content":"llo"}}]}',
    'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":5}}',
    "data: [DONE]",
    "",
  ].join("\n");
  const fetchImpl = (async () => new Response(sse, { status: 200 })) as typeof fetch;
  const p = new OpenAICompatibleProvider({ fetchImpl });
  const deltas: string[] = [];
  let final;
  for await (const ev of p.stream([{ role: "user", content: "hi", ts: "t" }])) {
    if (ev.delta) deltas.push(ev.delta);
    if (ev.completion) final = ev.completion;
  }
  assert.equal(deltas.join(""), "hello");
  assert.equal(final?.content, "hello");
  assert.equal(final?.tokens, 5);
  assert.deepEqual(final?.toolCalls, []);
});

test("HTTP error surfaces as MODEL_HTTP_ERROR without retry on 4xx", async () => {
  const fetchImpl = fetchJson({ error: { message: "bad request" } }, [400]) as typeof fetch & { calls: RequestInit[] };
  const p = new OpenAICompatibleProvider({ fetchImpl, maxRetries: 3 });
  await assert.rejects(p.complete([{ role: "user", content: "hi", ts: "t" }]), /model request failed: 400/);
  assert.equal(fetchImpl.calls.length, 1);
});

test("toolSchemasFromRegistry maps action params to JSON schema", () => {
  const { registry } = createDefaultToolRegistry();
  const { schemas, resolve } = toolSchemasFromRegistry(registry);
  const write = schemas.find((s) => s.name === "filesystem__write");
  assert.ok(write, "filesystem__write schema exists");
  const props = write!.parameters as { properties: Record<string, { type: string }>; required: string[] };
  assert.equal(props.properties.path.type, "string");
  assert.ok(props.required.includes("path"));
  const list = schemas.find((s) => s.name === "filesystem__list");
  assert.ok(list);
  const listProps = list!.parameters as { properties: Record<string, { type?: string; items?: { type: string } }> };
  assert.equal(listProps.properties.maxEntries.type, "number", "optional marker stripped");
  assert.deepEqual(resolve("filesystem__write"), { tool: "filesystem", action: "write" });
  assert.equal(resolve("nope"), null);
});

test("trimConversation keeps system message and tool pairing", () => {
  const sys = { role: "system" as const, content: "s", ts: "t" };
  const a1 = { role: "assistant" as const, content: "", ts: "t", toolCalls: [{ id: "c1", name: "x", arguments: "{}" }] };
  const t1 = { role: "tool" as const, content: "r1", ts: "t", toolCallId: "c1" };
  const filler = (i: number) => ({ role: "user" as const, content: `m${i}`, ts: "t" });
  const messages = [sys, a1, t1, ...Array.from({ length: 70 }, (_, i) => filler(i))];
  const trimmed = trimConversation(messages, 60);
  assert.equal(trimmed[0].role, "system");
  assert.ok(trimmed.length <= 61);
  // the c1 pair survives or is dropped as a unit — never a dangling tool message first
  if (trimmed.some((m) => m.role === "tool" && m.toolCallId === "c1")) {
    const idx = trimmed.findIndex((m) => m.role === "tool");
    assert.equal(trimmed[idx - 1]?.toolCalls?.[0]?.id, "c1");
  }
  assert.ok(trimmed.some((m) => m.role === "user" && m.content === "m69"), "recent messages kept");
});

test("hookMatches patterns", () => {
  assert.equal(hookMatches(undefined, "terminal", "execute"), true);
  assert.equal(hookMatches("*", "terminal", "execute"), true);
  assert.equal(hookMatches("terminal", "terminal", "execute"), true);
  assert.equal(hookMatches("terminal", "filesystem", "read"), false);
  assert.equal(hookMatches("terminal.*", "terminal", "execute"), true);
  assert.equal(hookMatches("terminal.execute", "terminal", "execute"), true);
  assert.equal(hookMatches("terminal.execute", "terminal", "list"), false);
  assert.equal(hookMatches("filesystem.read", "terminal", "execute"), false);
});

test("paramsFromSchema maps JSON schema types to registry descriptors", () => {
  const params = paramsFromSchema({
    type: "object",
    properties: { text: { type: "string" }, count: { type: "integer" }, flag: { type: "boolean" }, tags: { type: "array" }, meta: { type: "object" }, extra: {} },
    required: ["text"],
  });
  assert.deepEqual(params, { text: "string", count: "number?", flag: "boolean?", tags: "string[]?", meta: "object?", extra: "any?" });
});

test("mcpToolRegistryName sanitises names", () => {
  assert.equal(mcpToolRegistryName("github", "create_issue"), "mcp_github_create_issue");
  assert.equal(mcpToolRegistryName("my server", "tool.x"), "mcp_my_server_tool_x");
});

test("extractJson edge cases", () => {
  assert.deepEqual(extractJson('{"a":{"b":[1,2]}}'), { a: { b: [1, 2] } });
  assert.throws(() => extractJson("no json here"), /no valid JSON/);
  assert.throws(() => extractJson('{"unterminated": [1,2}'), /no valid JSON/);
});
