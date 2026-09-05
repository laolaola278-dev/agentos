import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fsp from "node:fs/promises";
import path from "node:path";
import { runChat } from "@/agentos/chat";
import { makeRuntime, MockModelProvider, toolCall } from "../helpers";

/** Collects the injected output stream into a pollable string buffer. */
function captureOutput(stream: PassThrough): { text: () => string; waitUntil: (predicate: (t: string) => boolean, what: string) => Promise<void> } {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  const text = () => Buffer.concat(chunks).toString("utf8");
  const waitUntil = (predicate: (t: string) => boolean, what: string) =>
    new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const tick = () => {
        if (predicate(text())) return resolve();
        if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${what}; output so far:\n${text().slice(-1500)}`));
        setTimeout(tick, 50);
      };
      tick();
    });
  return { text, waitUntil };
}

test("runChat full session: banner, /tools, streamed goal turn, /exit", async () => {
  const provider = new MockModelProvider({
    turns: [
      { content: "Writing repl.txt now.", tokens: 5, toolCalls: [toolCall("filesystem__write", { path: "repl.txt", content: "repl-ok" })] },
      { content: "Finished writing repl.txt.", tokens: 5, toolCalls: [] },
    ],
  });
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  const input = new PassThrough();
  const output = new PassThrough();
  const cap = captureOutput(output);
  const session = runChat(rt, { autoApprove: true, input, output });
  try {
    input.write("/tools\n");
    await cap.waitUntil((t) => t.includes("filesystem: read"), "/tools listing");

    input.write("create repl.txt containing repl-ok\n");
    await cap.waitUntil((t) => t.includes("[COMPLETED]"), "task completion line");
    assert.match(cap.text(), /Writing repl.txt now\./, "model text streamed into the output stream");
    assert.match(cap.text(), /Finished writing repl\.txt\./, "closing message printed");
    assert.match(cap.text(), /⚙ filesystem\.write/, "tool call rendered");
    assert.match(cap.text(), /✓ filesystem/, "tool completion rendered");
    assert.equal(await fsp.readFile(path.join(dir, "repl.txt"), "utf8"), "repl-ok");

    // back at the prompt: /tasks lists the finished task, then leave
    await cap.waitUntil((t) => t.split("agentos>").length >= 4, "prompt after the goal turn");
    input.write("/tasks\n");
    await cap.waitUntil((t) => t.includes("COMPLETED  create repl.txt"), "/tasks listing");
    await cap.waitUntil((t) => t.split("agentos>").length >= 5, "prompt after /tasks");
    input.write("/exit\n");
    const exitCode = await session;
    assert.equal(exitCode, 0);
  } finally {
    input.end();
    await Promise.race([session.catch(() => undefined), new Promise((r) => setTimeout(r, 8000))]);
    await cleanup();
  }
});

test("runChat command toggles, unknown command, and graceful EOF exit", async () => {
  const provider = new MockModelProvider({ turns: [{ content: "done", tokens: 1, toolCalls: [] }] });
  const { rt, cleanup } = await makeRuntime({ model: provider });
  const input = new PassThrough();
  const output = new PassThrough();
  const cap = captureOutput(output);
  const session = runChat(rt, { input, output });
  try {
    input.write("/auto\n");
    await cap.waitUntil((t) => t.includes("permission mode: auto"), "/auto toggle");
    input.write("/confirm\n");
    await cap.waitUntil((t) => t.includes("permission mode: confirm"), "/confirm toggle");
    input.write("/definitely-not-a-command\n");
    await cap.waitUntil((t) => t.includes("unknown command: /definitely-not-a-command"), "unknown command message");
    input.end(); // stdin closed → graceful exit without /exit
    const exitCode = await session;
    assert.equal(exitCode, 0);
  } finally {
    input.end();
    await Promise.race([session.catch(() => undefined), new Promise((r) => setTimeout(r, 8000))]);
    await cleanup();
  }
});

test("runChat /confirm prompts for tool calls and honours a denial", async () => {
  const provider = new MockModelProvider({
    turns: [
      { content: "", tokens: 5, toolCalls: [toolCall("filesystem__write", { path: "asked.txt", content: "x" })] },
      { content: "understood, I will not write it.", tokens: 5, toolCalls: [] },
    ],
  });
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  const input = new PassThrough();
  const output = new PassThrough();
  const cap = captureOutput(output);
  const session = runChat(rt, { input, output }); // confirm mode (default)
  try {
    input.write("write asked.txt\n");
    // the researcher's workspace listing asks first — allow it
    await cap.waitUntil((t) => t.includes("[confirm] allow filesystem.list? (y/N)"), "permission prompt for the researcher's list");
    input.write("y\n");
    // the actual write asks next — deny it
    await cap.waitUntil((t) => t.includes("[confirm] allow filesystem.write? (y/N)"), "permission prompt for the write");
    input.write("n\n");
    // the tool call never runs (objective gate coverage with FAILED lives in chat.test.ts);
    // here the agent reports back and the turn completes
    await cap.waitUntil((t) => t.includes("✗ filesystem") && t.includes("PERMISSION_DENIED"), "denied tool call rendered");
    await cap.waitUntil((t) => t.includes("[COMPLETED]"), "turn completes after the agent reacts to the denial");
    input.write("/exit\n");
    const exitCode = await session;
    assert.equal(exitCode, 0);
    const exists = await fsp.access(path.join(dir, "asked.txt")).then(
      () => true,
      () => false,
    );
    assert.equal(exists, false, "denied file was never created");
  } finally {
    input.end();
    await Promise.race([session.catch(() => undefined), new Promise((r) => setTimeout(r, 8000))]);
    await cleanup();
  }
});

test("chat session persists turns and --resume seeds context into the first turn", async () => {
  const capturedTurnMessages: { role: string; content: string }[][] = [];
  const provider = new MockModelProvider({
    onTools: (turn, messages) => {
      capturedSystem.push(messages[0]?.content ?? "");
      capturedTurnMessages.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return turn === 1
        ? { content: "", tokens: 1, toolCalls: [toolCall("filesystem__write", { path: "r.txt", content: "v" }, "call_r1")] }
        : { content: "turn finished", tokens: 1, toolCalls: [] };
    },
  });
  const capturedSystem: string[] = [];
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  const input = new PassThrough();
  const output = new PassThrough();
  const cap = captureOutput(output);
  // a prior session file exists BEFORE the REPL starts (as if from an earlier chat run)
  const { saveChatSession } = await import("@/agentos/chat");
  await saveChatSession(path.join(dir, ".agentos"), { ts: new Date().toISOString(), goal: "refactor the auth module", status: "COMPLETED", summary: "auth module refactored, tests green" });
  const session = runChat(rt, { autoApprove: true, input, output, resume: true });
  try {
    await cap.waitUntil((t) => t.split("agentos>").length >= 2, "first prompt ready");
    input.write("continue with the next step\n");
    await cap.waitUntil((t) => t.includes("[COMPLETED]"), "first turn completes");
    await cap.waitUntil((t) => t.split("agentos>").length >= 3, "prompt after turn");
    assert.match(cap.text(), /resumed session: 1 prior turn/, "resume banner");

    // transcript-level resume: prior user/assistant turns are real conversation messages
    const firstTurnMessages = capturedSystem.length ? (capturedTurnMessages[0] ?? []) : [];
    assert.ok(
      firstTurnMessages.some((m) => m.role === "user" && m.content.includes("refactor the auth module")),
      "prior user turn replayed into the conversation",
    );
    assert.ok(
      firstTurnMessages.some((m) => m.role === "assistant" && m.content.includes("auth module refactored")),
      "prior assistant turn replayed into the conversation",
    );

    // the turn itself was persisted for the next resume
    const turns = JSON.parse(await fsp.readFile(path.join(dir, ".agentos", "chat-session.json"), "utf8")) as { turns: { goal: string }[] };
    assert.ok(turns.turns.some((t) => t.goal.includes("continue with the next step")), "turn persisted");

    input.write("/exit\n");
    assert.equal(await session, 0);
  } finally {
    input.end();
    await Promise.race([session.catch(() => undefined), new Promise((r) => setTimeout(r, 8000))]);
    await cleanup();
  }
});

test("extra slash commands can be registered and /help lists them", async () => {
  const provider = new MockModelProvider({});
  const { rt, cleanup } = await makeRuntime({ model: provider });
  const input = new PassThrough();
  const output = new PassThrough();
  const cap = captureOutput(output);
  const session = runChat(rt, {
    input,
    output,
    extraCommands: { mystatus: { description: "show custom status", handler: () => cap2Print() } },
  });
  function cap2Print() {
    output.write("custom-status-ok\n");
  }
  try {
    await cap.waitUntil((t) => t.split("agentos>").length >= 2, "first prompt ready");
    input.write("/mystatus\n");
    await cap.waitUntil((t) => t.includes("custom-status-ok"), "extra command executed");
    input.write("/help\n");
    await cap.waitUntil((t) => t.includes("mystatus"), "/help lists the extra command");
    input.write("/exit\n");
    assert.equal(await session, 0);
  } finally {
    input.end();
    await Promise.race([session.catch(() => undefined), new Promise((r) => setTimeout(r, 8000))]);
    await cleanup();
  }
});
