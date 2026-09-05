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
