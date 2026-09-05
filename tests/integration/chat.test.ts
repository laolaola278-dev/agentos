import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { makeRuntime, MockModelProvider, toolCall } from "../helpers";
import { chatTurn, type ChatHandlers } from "@/agentos/chat";
import type { PermissionRequest } from "@/agentos/types";

function captureHandlers(): ChatHandlers & { lines: string[]; deltas: string[] } {
  const lines: string[] = [];
  const deltas: string[] = [];
  return {
    lines,
    deltas,
    print: (line) => lines.push(line),
    printDelta: (text) => deltas.push(text),
  };
}

test("chat turn streams model output and completes an agentic task", async () => {
  const provider = new MockModelProvider({
    turns: [
      { content: "Writing the greeting file now.", tokens: 10, toolCalls: [toolCall("filesystem__write", { path: "chat.txt", content: "from chat" })] },
      { content: "Done — chat.txt written.", tokens: 10, toolCalls: [] },
    ],
  });
  const { rt, dir, cleanup } = await makeRuntime({ model: provider });
  try {
    const h = captureHandlers();
    const res = await chatTurn(rt, "create chat.txt containing 'from chat'", h);
    assert.equal(res.status, "COMPLETED", res.error);
    assert.equal(await fsp.readFile(path.join(dir, "chat.txt"), "utf8"), "from chat");
    // streamed model text reached the handler as deltas
    const streamed = h.deltas.join("");
    assert.match(streamed, /Writing the greeting file now/);
    assert.match(streamed, /Done — chat.txt written/);
    // tool activity was rendered
    assert.ok(h.lines.some((l) => l.includes("⚙ filesystem.write")), `lines: ${h.lines.join(" | ")}`);
    assert.ok(h.lines.some((l) => l.includes("✓ filesystem")));
    // the model's closing message is the chat summary
    assert.match(res.summary ?? "", /Done — chat.txt written/);
    // transient deltas never hit the store
    const stored = await rt.bus.query({ taskId: res.taskId });
    assert.ok(stored.every((e) => e.type !== "model.delta"), "deltas are transient");
    assert.ok(stored.some((e) => e.type === "model.completed"));
  } finally {
    await cleanup();
  }
});

test("chat turn without a model fails with an actionable message", async () => {
  const { rt, cleanup } = await makeRuntime({});
  try {
    await assert.rejects(chatTurn(rt, "do something", captureHandlers()), /set LLM_API_KEY/);
  } finally {
    await cleanup();
  }
});

test("confirm permission mode makes the agent fail the denied call instead of executing it", async () => {
  const provider = new MockModelProvider({
    turns: [
      { content: "", tokens: 5, toolCalls: [toolCall("filesystem__write", { path: "denied.txt", content: "nope" })] },
      { content: "understood, stopping.", tokens: 5, toolCalls: [] },
    ],
  });
  const denied: PermissionRequest[] = [];
  const { rt, dir, cleanup } = await makeRuntime({
    model: provider,
    permissionMode: "confirm",
    onPermissionRequest: async (req) => {
      denied.push(req);
      return false;
    },
  });
  try {
    const h = captureHandlers();
    const res = await chatTurn(rt, "write denied.txt", h, {
      acceptance: [{ type: "file_exists", path: "denied.txt" }],
    });
    assert.equal(res.status, "FAILED", "acceptance on the denied file makes the failure objective");
    // the researcher's filesystem.list asks first, then the denied write
    assert.deepEqual(denied.map((r) => `${r.tool}.${r.action}`), ["filesystem.list", "filesystem.write"]);
    const exists = await fsp.access(path.join(dir, "denied.txt")).then(
      () => true,
      () => false,
    );
    assert.equal(exists, false, "denied file was never written");
    assert.ok(h.lines.some((l) => l.includes("✗ filesystem") && l.includes("PERMISSION_DENIED")));
  } finally {
    await cleanup();
  }
});
