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

test("agentic mode falls back to non-streaming tool calls when the provider quirk says so", async () => {
  const provider = new MockModelProvider({
    turns: [
      { content: "", tokens: 5, toolCalls: [toolCall("filesystem__write", { path: "quirk.txt", content: "ok" })] },
      { content: "done via non-streaming", tokens: 5, toolCalls: [] },
    ],
  });
  provider.quirks = { toolStreaming: false }; // reverse-proxy compat: no SSE tool_calls
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  try {
    const task = await rt.createTask({
      title: "quirk fallback",
      goal: "write quirk.txt",
      mode: "agentic",
      acceptance: [{ type: "file_exists", path: "quirk.txt" }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", done.error);
    assert.equal(provider.streamCount, 0, "stream() never called");
    assert.equal(provider.turnCount, 2, "completeWithTools drove the turns");
    assert.equal(await fsp.readFile(path.join(dir, "quirk.txt"), "utf8"), "ok");
  } finally {
    await cleanup();
  }
});

test("agentic mode repairs malformed tool-call JSON instead of failing the call", async () => {
  const provider = new MockModelProvider({
    onTools: (turn) =>
      turn === 1
        ? { content: "", tokens: 5, toolCalls: [toolCall("filesystem__write", { path: "repaired.txt", content: "x" }, "call_1")] }
        : { content: "done", tokens: 5, toolCalls: [] },
  });
  // simulate a model that emits a trailing-comma + fence-wrapped argument blob
  const orig = provider.completeWithTools.bind(provider);
  (provider as unknown as { completeWithTools: unknown }).completeWithTools = async (messages: unknown, tools: unknown) => {
    const res = await orig(messages as never, tools as never);
    if (res.toolCalls.length) res.toolCalls[0].arguments = '```json\n{"path":"repaired.txt","content":"x",}\n```';
    return res;
  };
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  try {
    const task = await rt.createTask({
      title: "repair test",
      goal: "write repaired.txt",
      mode: "agentic",
      acceptance: [{ type: "file_exists", path: "repaired.txt" }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", `task ${done.status}: ${done.error}`);
    assert.equal(await fsp.readFile(path.join(dir, "repaired.txt"), "utf8"), "x");
    assert.ok(done.result?.stepResults.every((r) => r.ok), "no failed steps — the argument blob was repaired");
  } finally {
    await cleanup();
  }
});

test("agentic mode executes a turn's multiple tool calls in parallel", async () => {
  const provider = new MockModelProvider({
    turns: [
      {
        content: "writing two files",
        tokens: 5,
        toolCalls: [
          toolCall("filesystem__write", { path: "p1.txt", content: "one" }, "call_par1"),
          toolCall("filesystem__write", { path: "p2.txt", content: "two" }, "call_par2"),
          toolCall("terminal__execute", { command: "sleep 0.5" }, "call_par3"),
        ],
      },
      { content: "both files written in parallel", tokens: 5, toolCalls: [] },
    ],
  });
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  try {
    const task = await rt.createTask({
      title: "parallel calls",
      goal: "write p1.txt and p2.txt",
      mode: "agentic",
      acceptance: [
        { type: "file_contains", path: "p1.txt", text: "one" },
        { type: "file_contains", path: "p2.txt", text: "two" },
      ],
    });
    const started = Date.now();
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    const elapsed = Date.now() - started;
    assert.equal(done.status, "COMPLETED", done.error);
    assert.equal(await fsp.readFile(path.join(dir, "p1.txt"), "utf8"), "one");
    assert.equal(await fsp.readFile(path.join(dir, "p2.txt"), "utf8"), "two");
    // three calls, one being sleep 0.5: sequential would exceed 1.5s on process
    // spawn alone; parallel finishes well under that. Generous bound keeps it stable.
    assert.ok(elapsed < 4000, `parallel turn should be quick, took ${elapsed}ms`);
    assert.equal(done.result?.stepResults.length, 3, "all three calls recorded");
    // model-order pairing preserved: results are in the order the model emitted them
    assert.match(done.result!.stepResults[0].stepId, /call_par1/);
    assert.match(done.result!.stepResults[2].stepId, /call_par3/);
  } finally {
    await cleanup();
  }
});

test("agentic mode delegates to isolated subagents via the subagent tool", async () => {
  const provider = new MockModelProvider({
    turns: [
      {
        content: "delegating",
        tokens: 5,
        toolCalls: [
          toolCall("subagent__run", {
            goal: "write child.txt",
            mode: "plan",
            steps: [{ id: "s1", tool: "filesystem", action: "write", args: { path: "child.txt", content: "from-child" } }],
            acceptance: [{ type: "file_exists", path: "child.txt" }],
          }),
        ],
      },
      { content: "subagent finished the isolated write", tokens: 5, toolCalls: [] },
    ],
  });
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  try {
    assert.ok(rt.tools.get("subagent"), "subagent tool registered by default");
    const task = await rt.createTask({
      title: "delegate",
      goal: "produce child.txt via a subagent",
      mode: "agentic",
      acceptance: [{ type: "file_contains", path: "child.txt", text: "from-child" }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", done.error);
    // the child really executed in the parent's workspace
    assert.equal(await fsp.readFile(path.join(dir, "child.txt"), "utf8"), "from-child");
    const subStep = done.result?.stepResults.find((r) => r.tool === "subagent");
    assert.ok(subStep?.ok, "subagent step succeeded");
    // context isolation: the parent sees a small structured result, not a transcript
    const data = subStep?.output?.data as { status?: string; summary?: string };
    assert.equal(data.status, "COMPLETED");
    assert.match(data.summary ?? "", /filesystem\.write=ok/);
    assert.ok(JSON.stringify(data).length < 2000, "parent context stays small");
  } finally {
    await cleanup();
  }
});

test("subagent can be disabled at runtime creation", async () => {
  const { rt, cleanup } = await makeRuntime({ subagent: false });
  try {
    assert.equal(rt.tools.get("subagent"), undefined);
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
