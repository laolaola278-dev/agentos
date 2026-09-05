import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { AgentRuntime } from "@/agentos/runtime";
import { tmpDir, makeRuntime, rmRetry } from "../helpers";
import type { AgentOsConfig } from "@/agentos/config";

const MCP_SERVER_JS = `const readline = require("readline");
const fs = require("fs");
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "test-mcp", version: "0.1.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "Echo the given text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "write_file", description: "Write a file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "boom", description: "Always fails", inputSchema: { type: "object", properties: {} } }
    ] } });
  } else if (msg.method === "tools/call") {
    const name = msg.params.name;
    const args = msg.params.arguments || {};
    if (name === "echo") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo: " + args.text }] } });
    else if (name === "write_file") { fs.writeFileSync(args.path, args.content); send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "wrote " + args.path }] } }); }
    else if (name === "boom") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "kaboom" }], isError: true } });
    else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool" } });
  }
});
`;

test("pre_tool_call hook with exit 2 blocks the tool call and fails the task", async () => {
  const config: AgentOsConfig = {
    hooks: {
      pre_tool_call: [{ match: "terminal.*", command: 'node -e "console.error(\'terminal blocked by policy\');process.exit(2)"' }],
    },
  };
  const { rt, cleanup } = await makeRuntime({ config });
  try {
    const task = await rt.createTask({
      title: "hooked terminal",
      goal: "n/a",
      steps: [{ id: "s1", tool: "terminal", action: "execute", args: { command: "echo never-ran" } }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "FAILED");
    assert.match(done.error ?? "", /HOOK_BLOCKED/);
    assert.match(done.error ?? "", /terminal blocked by policy/);
    const events = await rt.bus.query({ taskId: task.id });
    const hookEvent = events.find((e) => e.type === "hook.executed" && (e.data as { blocked?: boolean } | undefined)?.blocked);
    assert.ok(hookEvent, "hook.executed event with blocked=true");
    const toolFailed = events.find((e) => e.type === "tool.failed");
    assert.equal(toolFailed?.error, "HOOK_BLOCKED: terminal blocked by policy");
  } finally {
    await cleanup();
  }
});

test("non-blocking hook failures and post/task hooks fire without breaking the run", async () => {
  const config: AgentOsConfig = {
    hooks: {
      pre_tool_call: [{ match: "filesystem.*", command: 'node -e "console.error(\\"advisory warning\\");process.exit(1)"' }],
      post_tool_call: [{ match: "*", command: 'node -e "require(\'fs\').writeFileSync(\'posthook.txt\',\'fired\')"', timeoutMs: 15000 }],
      task_completed: [{ command: 'node -e "require(\'fs\').writeFileSync(\'completed-hook.txt\',\'fired\')"' }],
    },
  };
  const { rt, dir, cleanup } = await makeRuntime({ config });
  try {
    const task = await rt.createTask({
      title: "hooked completion",
      goal: "write done.txt: ok\ncheck exists done.txt",
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", `expected COMPLETED, got ${done.status} (${done.error})`);
    assert.equal(await fsp.readFile(path.join(dir, "posthook.txt"), "utf8"), "fired");
    assert.equal(await fsp.readFile(path.join(dir, "completed-hook.txt"), "utf8"), "fired");
    const events = await rt.bus.query({ taskId: task.id });
    const hookEvents = events.filter((e) => e.type === "hook.executed");
    assert.ok(hookEvents.length >= 2, `post hooks fired for the registry tool calls (${hookEvents.length})`);
    const advisory = hookEvents.find((e) => (e.data as { exitCode?: number } | undefined)?.exitCode === 1);
    assert.ok(advisory, "non-zero pre-hook recorded as non-blocking");
  } finally {
    await cleanup();
  }
});

test("MCP server tools join the registry and are usable from tasks", async () => {
  const dir = await tmpDir("agentos-mcp-");
  await fsp.writeFile(path.join(dir, "mcp-server.js"), MCP_SERVER_JS);
  const rt = await AgentRuntime.create({
    rootDir: dir,
    dataDir: path.join(dir, ".agentos"),
    persistence: "memory",
    model: null,
    controlPollMs: 0,
    config: { mcpServers: { test: { command: process.execPath, args: [path.join(dir, "mcp-server.js")], cwd: dir } } },
  });
  try {
    assert.ok(rt.tools.get("mcp_test_echo"), "echo tool registered");
    assert.ok(rt.tools.get("mcp_test_write_file"), "write_file tool registered");
    const doctor = await rt.doctor();
    assert.match(doctor.checks.find((c) => c.name === "mcp")?.detail ?? "", /mcp_test_echo/);

    const task = await rt.createTask({
      title: "mcp task",
      goal: "n/a",
      steps: [
        { id: "s1", tool: "mcp_test_echo", action: "call", args: { text: "hi" } },
        { id: "s2", tool: "mcp_test_write_file", action: "call", args: { path: "mcp.txt", content: "from mcp" } },
      ],
      acceptance: [{ type: "file_exists", path: "mcp.txt" }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", `expected COMPLETED, got ${done.status} (${done.error})`);
    const echo = done.result?.stepResults.find((r) => r.stepId === "s1");
    assert.match(JSON.stringify(echo?.output?.data), /echo: hi/);
    assert.equal(await fsp.readFile(path.join(dir, "mcp.txt"), "utf8"), "from mcp");

    const bad = await rt.createTask({
      title: "mcp error",
      goal: "n/a",
      steps: [{ id: "s1", tool: "mcp_test_boom", action: "call", args: {} }],
    });
    await rt.startTask(bad.id);
    const badDone = await rt.waitForTask(bad.id);
    assert.equal(badDone.status, "FAILED");
    assert.match(badDone.error ?? "", /MCP_TOOL_ERROR|kaboom/);
  } finally {
    await rt.close();
    await rmRetry(dir);
  }
});

test("a down MCP server does not take the runtime offline", async () => {
  const dir = await tmpDir("agentos-mcp-down-");
  const rt = await AgentRuntime.create({
    rootDir: dir,
    dataDir: path.join(dir, ".agentos"),
    persistence: "memory",
    model: null,
    controlPollMs: 0,
    config: { mcpServers: { dead: { command: process.execPath, args: ["-e", "process.exit(3)"] } } },
  });
  try {
    assert.equal(rt.tools.get("mcp_dead_nothing"), undefined, "no tools registered from the dead server");
    const events = await rt.bus.query({ typePrefix: "mcp." });
    assert.ok(events.some((e) => e.type === "mcp.failed"), "mcp.failed event emitted");
    const task = await rt.createTask({ title: "still works", goal: "write ok.txt: fine\ncheck exists ok.txt" });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED");
  } finally {
    await rt.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("config.json in the data dir is auto-loaded by AgentRuntime.create", async () => {
  const dir = await tmpDir("agentos-cfg-auto-");
  const dataDir = path.join(dir, ".agentos");
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(
    path.join(dataDir, "config.json"),
    JSON.stringify({ hooks: { post_tool_call: [{ command: 'node -e "require(\'fs\').writeFileSync(\'auto-hook.txt\',\'fired\')"' }] } }),
  );
  const rt = await AgentRuntime.create({ rootDir: dir, dataDir, persistence: "memory", model: null, controlPollMs: 0 });
  try {
    const task = await rt.createTask({ title: "auto config", goal: "write auto.txt: x\ncheck exists auto.txt" });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED");
    assert.equal(await fsp.readFile(path.join(dir, "auto-hook.txt"), "utf8"), "fired", "auto-loaded hook executed");
  } finally {
    await rt.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
