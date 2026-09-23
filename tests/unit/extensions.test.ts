import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { EventBus } from "@/agentos/events";
import { MemoryPersistence } from "@/agentos/persistence";
import { ToolRegistry } from "@/agentos/tools/registry";
import { compactConversation, readProjectInstructions } from "@/agentos/agents";
import { createDefaultToolRegistry } from "@/agentos/tools";
import type { Message, ToolInput } from "@/agentos/types";
import { tmpDir, MockModelProvider, rmRetry } from "../helpers";

// ---- transient events ----------------------------------------------------

test("transient events fan out to subscribers but are never persisted", async () => {
  const bus = new EventBus(new MemoryPersistence());
  await bus.syncSequence();
  const seen: string[] = [];
  const unsub = bus.subscribe((e) => {
    seen.push(e.type);
  });
  await bus.emit({ taskId: "t", agentId: null, type: "model.delta", transient: true, data: { text: "he" } });
  await bus.emit({ taskId: "t", agentId: null, type: "model.delta", transient: true, data: { text: "llo" } });
  await bus.emit({ taskId: "t", agentId: null, type: "model.completed" });
  unsub();
  assert.deepEqual(seen, ["model.delta", "model.delta", "model.completed"], "subscribers see everything live");
  const stored = await bus.query({ taskId: "t" });
  assert.deepEqual(stored.map((e) => e.type), ["model.completed"], "transient events are not in the store");
  const stats = bus.stats;
  assert.equal(stats.pending, 0);
});

// ---- permission gate ------------------------------------------------------

function registryWithProbeTool(): ToolRegistry {
  const registry = new ToolRegistry().register({
    name: "probe",
    description: "test tool",
    actions: [{ name: "ping", description: "returns pong", params: {} }],
    async execute(input: ToolInput) {
      return { pong: true, action: input.action };
    },
  });
  return registry;
}

test("permission gate confirm mode: denial blocks the call with PERMISSION_DENIED", async () => {
  const registry = registryWithProbeTool();
  const requests: string[] = [];
  registry.setPermissionGate({
    mode: "confirm",
    request: async (req) => {
      requests.push(`${req.tool}.${req.action}`);
      return false;
    },
  });
  const out = await registry.execute("probe", { action: "ping", args: {} }, { taskId: "t", agentId: "test", workdir: "." });
  assert.equal(out.ok, false);
  assert.equal(out.error?.code, "PERMISSION_DENIED");
  assert.deepEqual(requests, ["probe.ping"]);
});

test("permission gate confirm mode: approval runs the tool; prompt failure denies", async () => {
  const registry = registryWithProbeTool();
  registry.setPermissionGate({ mode: "confirm", request: async () => true });
  const ok = await registry.execute("probe", { action: "ping", args: {} }, { taskId: "t", agentId: "test", workdir: "." });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, { pong: true, action: "ping" });

  const failing = registryWithProbeTool();
  failing.setPermissionGate({
    mode: "confirm",
    request: async () => {
      throw new Error("terminal closed");
    },
  });
  const denied = await failing.execute("probe", { action: "ping", args: {} }, { taskId: "t", agentId: "test", workdir: "." });
  assert.equal(denied.error?.code, "PERMISSION_DENIED", "a failed prompt is fail-closed");
});

test("permission gate auto mode never prompts (default behaviour unchanged)", async () => {
  const registry = registryWithProbeTool();
  let asked = 0;
  registry.setPermissionGate({ mode: "auto", request: async () => (asked++, true) });
  const out = await registry.execute("probe", { action: "ping", args: {} }, { taskId: "t", agentId: "test", workdir: "." });
  assert.equal(out.ok, true);
  assert.equal(asked, 0);
});

test("createDefaultToolRegistry wires hooks and gates through runtime options", async () => {
  const { registry } = createDefaultToolRegistry();
  assert.equal(registry.get("filesystem") !== undefined, true);
  // gates are optional: without one, execution proceeds (backwards compatible)
  const out = await registry.execute("filesystem", { action: "exists", args: { path: "package.json" } }, { taskId: "t", agentId: "test", workdir: process.cwd() });
  assert.equal(out.ok, true);
});

// ---- context compaction ---------------------------------------------------

function msg(role: Message["role"], content: string, extra: Partial<Message> = {}): Message {
  return { role, content, ts: "t", ...extra };
}

test("compactConversation summarizes old turns with a model and keeps recent ones", async () => {
  const old = Array.from({ length: 105 }, (_, i) => msg("user", `older work item ${i}: wrote file-${i}.txt`));
  const recent = [msg("assistant", "recent step", { toolCalls: [{ id: "c1", name: "x", arguments: "{}" }] }), msg("tool", "recent result", { toolCallId: "c1" }), msg("assistant", "recent conclusion")];
  const system = msg("system", "system prompt");
  const model = new MockModelProvider({ completeResponse: "The agent wrote files 0-59 and just verified the latest one." });
  const { messages, compacted, summary } = await compactConversation([system, ...old, ...recent], model);
  assert.equal(compacted, true);
  assert.equal(messages[0].role, "system");
  assert.match(summary ?? "", /wrote files 0-59/);
  assert.ok(messages.length < 40, `conversation bounded (got ${messages.length})`);
  // pairing preserved: the tool result still follows its assistant tool_calls
  const idx = messages.findIndex((m) => m.toolCalls?.length);
  assert.ok(idx >= 0);
  assert.equal(messages[idx + 1].role, "tool");
  assert.match(messages[messages.length - 1].content, /recent conclusion/);
});

test("compactConversation without a model still bounds growth deterministically", async () => {
  const messages = [msg("system", "s"), ...Array.from({ length: 120 }, (_, i) => msg("user", `m${i}`))];
  const { messages: out, compacted } = await compactConversation(messages, null);
  assert.equal(compacted, true);
  assert.ok(out.length <= 35);
  assert.match(out[1].content, /\[context compacted\]/);
});

test("compactConversation leaves short conversations alone", async () => {
  const messages = [msg("system", "s"), msg("user", "hello")];
  const { messages: out, compacted } = await compactConversation(messages, null);
  assert.equal(compacted, false);
  assert.equal(out.length, 2);
});

test("compactConversation compacts a short but oversized conversation by token estimate", async () => {
  const messages = [msg("system", "s"), msg("user", "x".repeat(8_000)), msg("assistant", "y".repeat(8_000)), msg("user", "keep-me")];
  const { messages: out, compacted } = await compactConversation(messages, null, undefined, { maxTokens: 1000 });
  assert.equal(compacted, true);
  assert.match(out[1].content, /\[context compacted\]/);
  assert.match(out[out.length - 1].content, /keep-me/);
  assert.ok(out.length < messages.length);
});

// ---- project instructions -------------------------------------------------

test("readProjectInstructions picks up AGENTS.md from the workspace", async () => {
  const dir = await tmpDir("agentos-instr-");
  try {
    assert.equal(await readProjectInstructions(dir), null);
    await fsp.writeFile(path.join(dir, "AGENTS.md"), "# Project rules\n- use pnpm\n- never touch /legacy");
    const text = await readProjectInstructions(dir);
    assert.match(text ?? "", /use pnpm/);
    assert.match(text ?? "", /never touch/);
  } finally {
    await rmRetry(dir);
  }
});

test("readProjectInstructions falls back to CLAUDE.md and truncates huge files", async () => {
  const dir = await tmpDir("agentos-instr2-");
  try {
    await fsp.writeFile(path.join(dir, "CLAUDE.md"), "claude conventions");
    assert.match(await readProjectInstructions(dir) ?? "", /claude conventions/);
    await fsp.writeFile(path.join(dir, "AGENTS.md"), "x".repeat(9000));
    const capped = await readProjectInstructions(dir, 8000);
    assert.ok((capped ?? "").length <= 8100);
    assert.match(capped ?? "", /truncated/);
  } finally {
    await rmRetry(dir);
  }
});

// ---- lazy db module --------------------------------------------------------

test("importing @/db without DATABASE_URL does not throw; first use does", async () => {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const script = `
    import("./src/db/index.ts").then(async (m) => {
      try {
        void m.db.select;
        console.error("expected first use to throw");
        process.exit(1);
      } catch {
        process.exit(0);
      }
    }).catch((e) => { console.error("import failed: " + e.message); process.exit(1); });
  `;
  await new Promise<void>((resolve, reject) => {
    const child = execFile(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "-e", script], { cwd: projectRoot, timeout: 60_000, env: { ...process.env, DATABASE_URL: "" } }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`lazy db check failed: ${err.message} ${stderr}`));
      resolve();
    });
    child.on("error", reject);
  });
});
