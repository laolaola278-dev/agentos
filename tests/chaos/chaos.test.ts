import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { makeRuntime } from "../helpers";
import { MemoryPersistence } from "@/agentos/persistence";
import { AgentRuntime } from "@/agentos/runtime";
import { ToolRegistry, createDefaultToolRegistry } from "@/agentos/tools";
import type { Tool } from "@/agentos/types";
import { tmpDir } from "../helpers";

/** Persistence that fails randomly / on demand — simulates an unavailable database. */
class FlakyPersistence extends MemoryPersistence {
  failRate = 0;
  down = false;
  private maybeFail(op: string) {
    if (this.down || Math.random() < this.failRate) throw new Error(`simulated storage failure (${op})`);
  }
  override async appendEvent(e: Parameters<MemoryPersistence["appendEvent"]>[0]) {
    this.maybeFail("appendEvent");
    return super.appendEvent(e);
  }
  override async saveCheckpoint(c: Parameters<MemoryPersistence["saveCheckpoint"]>[0]) {
    this.maybeFail("saveCheckpoint");
    return super.saveCheckpoint(c);
  }
  override async saveTask(t: Parameters<MemoryPersistence["saveTask"]>[0]) {
    this.maybeFail("saveTask");
    return super.saveTask(t);
  }
}

describe("chaos", () => {
  test("event store failing 30% of the time: no event loss once it recovers, task still completes", async () => {
    const dir = await tmpDir();
    const p = new FlakyPersistence();
    const rt = await AgentRuntime.create({ rootDir: dir, persistence: p, model: null, controlPollMs: 0 });
    try {
      // only events are flaky here; task/checkpoint writes must stay reliable for a clean completion
      const origSave = p.saveTask.bind(p);
      const origCp = p.saveCheckpoint.bind(p);
      p.saveTask = MemoryPersistence.prototype.saveTask.bind(p);
      p.saveCheckpoint = MemoryPersistence.prototype.saveCheckpoint.bind(p);
      p.failRate = 0.3;
      const t = await rt.createTask({ title: "flaky-store", goal: "write a.txt: 1\nwrite b.txt: 2\nrun: cat a.txt b.txt\ncheck exists b.txt" });
      const done = await rt.runTask(t.id);
      assert.equal(done.status, "COMPLETED", done.error);
      p.failRate = 0;
      await rt.bus.flushPending();
      assert.equal(rt.bus.stats.pending, 0);
      assert.equal(rt.bus.stats.droppedEvents, 0);
      assert.ok(rt.bus.stats.persistErrors > 0, "chaos actually happened");
      const persisted = await p.queryEvents({ taskId: t.id });
      const seqs = persisted.map((e) => e.seq).sort((a, b) => a - b);
      assert.equal(new Set(seqs).size, seqs.length, "no duplicate events");
      assert.equal(seqs.length, rt.bus.stats.seq, "every emitted event eventually persisted");
      p.saveTask = origSave;
      p.saveCheckpoint = origCp;
    } finally {
      await rt.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("database completely unavailable during checkpoint writes → task fails gracefully, runtime stays usable", async () => {
    const dir = await tmpDir();
    const p = new FlakyPersistence();
    const rt = await AgentRuntime.create({ rootDir: dir, persistence: p, model: null, controlPollMs: 0 });
    try {
      const t = await rt.createTask({ title: "db-down", goal: "run: sleep 0.6\nrun: echo hi" });
      await rt.startTask(t.id);
      await new Promise((r) => setTimeout(r, 200));
      p.down = true; // outage strikes while the first step is running
      const done = await rt.waitForTask(t.id);
      p.down = false;
      assert.equal(done.status, "FAILED");
      assert.match(done.error!, /storage failure|RUNTIME_ERROR/);
      // an outage before start surfaces as a clean error to the caller, not a crash
      const t3 = await rt.createTask({ title: "pre-down", goal: "run: echo x" });
      p.down = true;
      await assert.rejects(() => rt.startTask(t3.id), /storage failure/);
      p.down = false;
      // runtime still works afterwards
      const t2 = await rt.createTask({ title: "after", goal: "run: echo back" });
      assert.equal((await rt.runTask(t2.id)).status, "COMPLETED");
      await rt.bus.flushPending();
      assert.equal(rt.bus.stats.pending, 0);
    } finally {
      await rt.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("tool timeouts, tool crashes, invalid tool output and agent-level exceptions never crash the runtime", async () => {
    const { registry } = createDefaultToolRegistry();
    let calls = 0;
    const chaosTool: Tool = {
      name: "chaos",
      description: "randomly misbehaving tool",
      actions: [{ name: "act", description: "", params: {} }, { name: "flaky", description: "", params: {} }],
      async execute(input) {
        if (input.action === "flaky") {
          calls++;
          if (calls % 2 === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
          return { ok: true };
        }
        const roll = Math.random();
        if (roll < 0.25) throw new Error("tool crashed");
        if (roll < 0.5) throw { weird: "non-error object" };
        if (roll < 0.75) return undefined;
        return { circular: (() => { const o: Record<string, unknown> = {}; o.o = o; return o; })() };
      },
    };
    const reg = new ToolRegistry();
    for (const t of registry.list()) reg.register(registry.get(t.name)!);
    reg.register(chaosTool);
    const { rt, cleanup } = await makeRuntime({ tools: reg, concurrency: 8 });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) {
        const t = await rt.createTask({ title: `chaos${i}`, goal: "n/a", steps: [{ id: "c", tool: "chaos", action: "act", args: {} }], budget: { maxRetries: 1 } });
        ids.push(t.id);
      }
      const flaky = await rt.createTask({ title: "flaky-tool", goal: "n/a", steps: [{ id: "f", tool: "chaos", action: "flaky", args: {} }] });
      const timeout = await rt.createTask({ title: "tool-timeout", goal: "n/a", steps: [{ id: "s", tool: "terminal", action: "execute", args: { command: "sleep 30" }, timeoutMs: 300 }], budget: { maxRetries: 1 } });
      for (const id of [...ids, flaky.id, timeout.id]) await rt.startTask(id);
      await rt.waitForIdle();
      const statuses = ids.map((id) => rt.getTask(id)!.status);
      assert.ok(statuses.every((s) => s === "COMPLETED" || s === "FAILED"), JSON.stringify(statuses));
      assert.equal(rt.getTask(flaky.id)!.status, "COMPLETED", "ECONNRESET is retryable → self-corrected");
      const to = rt.getTask(timeout.id)!;
      assert.equal(to.status, "FAILED");
      assert.ok(to.usage.fixes >= 1, "timeout was diagnosed as transient and retried before giving up");
      assert.equal(rt.runningCount(), 0);
      assert.equal(rt.processes.list().filter((p) => p.running).length, 0, "timed-out processes are killed");
    } finally {
      await cleanup();
    }
  });

  test("filesystem failure mid-run (workdir deleted) → task fails with a clear error, no hang", async () => {
    const { rt, dir, cleanup } = await makeRuntime();
    try {
      const work = path.join(dir, "w");
      await fsp.mkdir(work);
      const t = await rt.createTask({ title: "fs-fail", goal: "n/a", workdir: "w", steps: [
        { id: "a", tool: "filesystem", action: "write", args: { path: "x.txt", content: "1" } },
        { id: "wait", tool: "terminal", action: "execute", args: { command: "sleep 0.8" } },
        { id: "b", tool: "filesystem", action: "write", args: { path: "y.txt", content: "2" } },
      ], budget: { maxRetries: 1, timeoutMs: 20_000 } });
      await rt.startTask(t.id);
      await new Promise((r) => setTimeout(r, 300));
      await fsp.rm(work, { recursive: true, force: true });
      const done = await rt.waitForTask(t.id);
      assert.equal(done.status, "FAILED");
      assert.ok(done.error);
    } finally {
      await cleanup();
    }
  });

  test("partially written checkpoint/task files are skipped on restart (file store)", async () => {
    const dir = await tmpDir();
    const rt = await AgentRuntime.create({ rootDir: dir, persistence: "file", model: null, controlPollMs: 0 });
    const t = await rt.createTask({ title: "ok", goal: "run: echo 1" });
    await rt.runTask(t.id);
    await rt.close();
    await fsp.writeFile(path.join(dir, ".agentos", "store", "tasks", "task_broken.json"), '{"id":"task_broken","status":"EXEC');
    await fsp.writeFile(path.join(dir, ".agentos", "store", "checkpoints", "task_broken.json"), "{ not json");
    const rt2 = await AgentRuntime.create({ rootDir: dir, persistence: "file", model: null, controlPollMs: 0 });
    try {
      assert.equal(rt2.listTasks().length, 1);
      assert.equal(rt2.getTask(t.id)!.status, "COMPLETED");
      assert.equal((await rt2.recoverAll()).recovered.length, 0);
    } finally {
      await rt2.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
