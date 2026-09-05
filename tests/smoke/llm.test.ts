import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { createModelProviderFromEnv } from "@/agentos/model";
import { makeRuntime, rmRetry } from "../helpers";

/**
 * Real-LLM smoke tier — exercises the agentic loop, tool schemas, streaming and
 * the review gate against a live OpenAI-compatible provider.
 *
 *   LLM_SMOKE=1 LLM_API_KEY=sk-... [LLM_BASE_URL=...] [LLM_MODEL=...] npm run test:smoke
 *
 * Skipped unless LLM_SMOKE=1 so the default suite stays offline and deterministic.
 */
const enabled = process.env.LLM_SMOKE === "1" && !!(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY);

test("real LLM drives an agentic task end-to-end", { skip: !enabled && "set LLM_SMOKE=1 + LLM_API_KEY to enable" }, async () => {
  const model = createModelProviderFromEnv();
  assert.ok(model, "provider must be constructible");
  const { rt, dir, cleanup } = await makeRuntime({ model, permissionMode: "auto" });
  try {
    const task = await rt.createTask({
      title: "llm smoke",
      goal: "Create the file smoke-ok.txt containing exactly: agentos smoke test passed. Then read it back to confirm, and finish with a one-line summary.",
      mode: "agentic",
      budget: { maxToolCalls: 12, timeoutMs: 5 * 60_000 },
      acceptance: [{ type: "file_contains", path: "smoke-ok.txt", text: "agentos smoke test passed" }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    const events = await rt.bus.query({ taskId: task.id });
    const toolCallEvents = events.filter((e) => e.type === "agent.tool_call");
    console.log(`[smoke] provider=${model.name} status=${done.status} turns=${toolCallEvents.length} tokens=${done.usage.tokens}`);
    assert.equal(done.status, "COMPLETED", `task ${done.status}: ${done.error}`);
    assert.equal(await fsp.readFile(path.join(dir, "smoke-ok.txt"), "utf8").then((s) => s.trim()), "agentos smoke test passed");
    assert.ok(done.usage.tokens > 0, "real provider reports token usage");
    assert.ok(done.result?.finalMessage, "model produced a closing message");
    // streaming deltas were emitted live (not persisted)
    const deltas = events.filter((e) => e.type === "model.delta");
    assert.equal(deltas.length, 0, "transient deltas stay out of the store");
  } finally {
    await cleanup();
    await rmRetry(path.join(dir));
  }
});
