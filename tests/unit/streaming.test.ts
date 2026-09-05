import test from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleProvider } from "@/agentos/model";

/** Builds a fake SSE response body from an array of data payloads. */
function sseResponse(payloads: unknown[]): Response {
  const text = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200 });
}

test("stream with tools reassembles tool_call fragments split across chunks", async () => {
  const payloads = [
    { choices: [{ delta: { role: "assistant", content: "I will " } }] },
    { choices: [{ delta: { content: "write the file." } }] },
    // tool call arrives in fragments: id+name first, then arguments in pieces
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "filesystem__write", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.txt","content":"hi"}' } }] } }] },
    // a second tool call on a different index
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "terminal__execute", arguments: '{"command":"cat a.txt"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { total_tokens: 99 } },
  ];
  const fetchImpl = (async () => sseResponse(payloads)) as typeof fetch;
  const p = new OpenAICompatibleProvider({ fetchImpl });
  const deltas: string[] = [];
  let final;
  for await (const ev of p.stream([{ role: "user", content: "go", ts: "t" }], { tools: [{ name: "filesystem__write", description: "w", parameters: {} }] })) {
    if (ev.delta) deltas.push(ev.delta);
    if (ev.completion) final = ev.completion;
  }
  assert.equal(deltas.join(""), "I will write the file.");
  assert.equal(final?.finishReason, "tool_calls");
  assert.equal(final?.tokens, 99);
  assert.deepEqual(final?.toolCalls, [
    { id: "call_a", name: "filesystem__write", arguments: '{"path":"a.txt","content":"hi"}' },
    { id: "call_b", name: "terminal__execute", arguments: '{"command":"cat a.txt"}' },
  ]);
});

test("stream with tools sends tools in the request body", async () => {
  let body: Record<string, unknown> | null = null;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([{ choices: [{ delta: { content: "ok" } }] }]);
  }) as typeof fetch;
  const p = new OpenAICompatibleProvider({ fetchImpl });
  for await (const ev of p.stream([{ role: "user", content: "hi", ts: "t" }], { tools: [{ name: "filesystem__read", description: "r", parameters: { type: "object" } }] })) {
    void ev;
  }
  assert.ok(body);
  assert.deepEqual((body as { tools: { type: string }[] }).tools, [{ type: "function", function: { name: "filesystem__read", description: "r", parameters: { type: "object" } } }]);
  assert.equal((body as { tool_choice: string }).tool_choice, "auto");
});

test("stream without tools estimates tokens when usage is absent", async () => {
  const fetchImpl = (async () => sseResponse([{ choices: [{ delta: { content: "1234567890" } }] }])) as typeof fetch;
  const p = new OpenAICompatibleProvider({ fetchImpl });
  let final;
  for await (const ev of p.stream([{ role: "user", content: "hi", ts: "t" }])) {
    if (ev.completion) final = ev.completion;
  }
  assert.equal(final?.tokens, 3); // ceil(10/4)
  assert.deepEqual(final?.toolCalls, []);
});
