import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { makeRuntime, MockModelProvider, toolCall } from "../helpers";

test("agentic mode: LLM drives tools, verification+review still gate completion", async () => {
  const provider = new MockModelProvider({
    turns: [
      { content: "I will create the file.", tokens: 12, toolCalls: [toolCall("filesystem__write", { path: "hello.txt", content: "hello world" })] },
      { content: "Created hello.txt with the greeting.", tokens: 8, toolCalls: [] },
    ],
  });
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  try {
    const task = await rt.createTask({
      title: "agentic hello",
      goal: "create hello.txt containing the text 'hello world'",
      mode: "agentic",
      acceptance: [{ type: "file_contains", path: "hello.txt", text: "hello world" }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", `expected COMPLETED, got ${done.status} (${done.error})`);

    // the file was really written by the model's tool call
    assert.equal(await fsp.readFile(path.join(dir, "hello.txt"), "utf8"), "hello world");

    // events: tool call + model completion + review
    const events = await rt.bus.query({ taskId: task.id });
    assert.ok(events.some((e) => e.type === "agent.tool_call" && e.tool === "filesystem"), "agent.tool_call event emitted");
    assert.ok(events.some((e) => e.type === "model.completed"), "model.completed events emitted");
    assert.ok(events.some((e) => e.type === "review.completed"), "independent reviewer still ran");

    // result: transcript steps recorded, plan is the agentic marker plan
    assert.ok(done.result?.stepResults.some((r) => r.tool === "filesystem" && r.action === "write" && r.ok), "write step recorded");
    assert.equal(done.result?.plan?.source, "model");
    assert.ok((done.usage.toolCalls ?? 0) >= 1, "tool call budget was consumed");
    assert.equal(provider.turnCount, 2, "two model turns");
  } finally {
    await cleanup();
  }
});

test("agentic mode: unknown tool call is fed back and the loop recovers", async () => {
  const provider = new MockModelProvider({
    turns: [
      { content: "", tokens: 5, toolCalls: [toolCall("definitely__missing", {})] },
      { content: "", tokens: 5, toolCalls: [toolCall("filesystem__write", { path: "recovered.txt", content: "ok" })] },
      { content: "recovered after the invalid call", tokens: 5, toolCalls: [] },
    ],
  });
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  try {
    const task = await rt.createTask({
      title: "agentic recovery",
      goal: "write recovered.txt",
      mode: "agentic",
      acceptance: [{ type: "file_exists", path: "recovered.txt" }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", `expected COMPLETED, got ${done.status} (${done.error})`);
    const failedStep = done.result?.stepResults.find((r) => !r.ok);
    assert.ok(failedStep, "the unknown-tool call is recorded as a failed step");
    assert.match(failedStep!.error ?? "", /unknown tool/);
    assert.equal(await fsp.readFile(path.join(dir, "recovered.txt"), "utf8"), "ok");
  } finally {
    await cleanup();
  }
});

test("agentic mode: tool-call budget is enforced and terminal", async () => {
  let n = 0;
  const provider = new MockModelProvider({
    onTools: () => ({ content: "", tokens: 5, toolCalls: [toolCall("filesystem__list", { path: "." }, `call_loop_${++n}`)] }),
  });
  const { rt, cleanup } = await makeRuntime({ model: provider });
  try {
    const task = await rt.createTask({
      title: "agentic budget",
      goal: "loop forever",
      mode: "agentic",
      budget: { maxToolCalls: 3 },
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "FAILED");
    assert.match(done.error ?? "", /BUDGET_EXCEEDED/);
    assert.ok((done.usage.toolCalls ?? 0) <= 4, "tool calls stayed near the budget");
  } finally {
    await cleanup();
  }
});

test("agentic mode without a model provider fails fast with MODEL_REQUIRED", async () => {
  const { rt, cleanup } = await makeRuntime({});
  try {
    const task = await rt.createTask({ title: "no llm", goal: "write hello.txt: hi", mode: "agentic" });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "FAILED");
    assert.match(done.error ?? "", /MODEL_REQUIRED/);
  } finally {
    await cleanup();
  }
});

test("agentic mode injects AGENTS.md project instructions into the system prompt", async () => {
  const captured: string[] = [];
  const provider = new MockModelProvider({
    onTools: (turn, messages) => {
      captured.push(messages[0]?.content ?? "");
      return turn === 1
        ? { content: "", tokens: 1, toolCalls: [toolCall("filesystem__write", { path: "ok.txt", content: "ok" })] }
        : { content: "done — ok.txt written", tokens: 1, toolCalls: [] };
    },
  });
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  try {
    await fsp.writeFile(path.join(dir, "AGENTS.md"), "# Project rules\n- always use pnpm here\n- keep tests deterministic");
    const task = await rt.createTask({
      title: "instructions",
      goal: "write ok.txt",
      mode: "agentic",
      acceptance: [{ type: "file_exists", path: "ok.txt" }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", done.error);
    assert.ok(captured.length >= 1, "model saw at least one turn");
    const systemPrompt = captured[0];
    assert.match(systemPrompt, /always use pnpm here/, "AGENTS.md content present in the system prompt");
    assert.match(systemPrompt, /keep tests deterministic/);
    assert.match(systemPrompt, /Goal: write ok\.txt/);
    assert.ok(systemPrompt.includes(dir), "workspace path present in the system prompt");
  } finally {
    await cleanup();
  }
});

test("invalid mode is rejected at task creation", async () => {
  const { rt, cleanup } = await makeRuntime({});
  try {
    await assert.rejects(rt.createTask({ title: "bad mode", goal: "x", mode: "yolo" as unknown as "agentic" }), /mode must be/);
  } finally {
    await cleanup();
  }
});
