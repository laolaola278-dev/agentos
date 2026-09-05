import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { makeRuntime, rmRetry } from "../helpers";
import { EventBus } from "@/agentos/events";
import { SqlitePersistence, FilePersistence } from "@/agentos/persistence";
import { createDefaultToolRegistry } from "@/agentos/tools";
import { tmpDir } from "../helpers";

const N_TASKS = Number(process.env.STRESS_TASKS ?? 200);

describe("stress", () => {
  test(`${N_TASKS} tasks with concurrency 16: all complete exactly once, no duplicates, no leaks`, async () => {
    const { rt, dir, cleanup } = await makeRuntime({ concurrency: 16, heartbeatMs: 60_000 });
    try {
      const memBefore = process.memoryUsage().heapUsed;
      const t0 = Date.now();
      const ids: string[] = [];
      for (let i = 0; i < N_TASKS; i++) {
        const t = await rt.createTask({ title: `t${i}`, goal: `write out/${i}.txt: ${i}\ncheck contains out/${i}.txt: ${i}`, priority: i % 5 });
        ids.push(t.id);
      }
      for (const id of ids) await rt.startTask(id);
      await rt.waitForIdle();
      const elapsed = Date.now() - t0;
      const statuses = ids.map((id) => rt.getTask(id)!.status);
      assert.equal(statuses.filter((s) => s === "COMPLETED").length, N_TASKS, JSON.stringify(statuses.filter((s) => s !== "COMPLETED")));
      const completedEvents = await rt.bus.query({ type: "task.completed" });
      assert.equal(completedEvents.length, N_TASKS, "exactly one completion event per task");
      assert.equal(new Set(completedEvents.map((e) => e.taskId)).size, N_TASKS);
      assert.equal((await fsp.readdir(path.join(dir, "out"))).length, N_TASKS);
      assert.equal(rt.runningCount(), 0);
      assert.equal((await rt.persistence.listCheckpoints()).length, 0, "no leaked checkpoints");
      assert.equal(rt.processes.list().length, 0, "no leaked processes");
      assert.equal(rt.bus.stats.pending, 0);
      global.gc?.();
      const memAfter = process.memoryUsage().heapUsed;
      console.log(`# stress: ${N_TASKS} tasks in ${elapsed}ms (${((N_TASKS / elapsed) * 1000).toFixed(1)} tasks/s), ${await rt.persistence.countEvents()} events, heap +${((memAfter - memBefore) / 1024 / 1024).toFixed(1)}MB`);
      assert.ok(memAfter - memBefore < 400 * 1024 * 1024, "heap growth bounded");
    } finally {
      await cleanup();
    }
  });

  test("many failing tasks + retries + blocked dependents stay consistent", async () => {
    const { rt, cleanup } = await makeRuntime({ concurrency: 8 });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 40; i++) {
        const fail = await rt.createTask({ title: `fail${i}`, goal: "n/a", steps: [{ id: "x", tool: "terminal", action: "execute", args: { command: "exit 1" }, retryable: i % 2 === 0 }], budget: { maxRetries: 1 } });
        const dep = await rt.createTask({ title: `dep${i}`, goal: "run: echo never", dependsOn: [fail.id] });
        ids.push(fail.id, dep.id);
      }
      for (const id of ids) await rt.startTask(id);
      await rt.waitForIdle();
      const tasks = ids.map((id) => rt.getTask(id)!);
      assert.equal(tasks.filter((t) => t.status === "FAILED").length, 40);
      assert.equal(tasks.filter((t) => t.status === "BLOCKED").length, 40);
      const failedEvents = await rt.bus.query({ type: "task.failed" });
      assert.equal(failedEvents.length, 40, "exactly one failure event per failed task");
      const files = await fsp.readdir(path.join(rt.dataDir, "failures"));
      assert.equal(files.length, 40, "one FAILURE_ANALYSIS per failed task");
      assert.ok((await rt.bus.query({ type: "agent.retry" })).length >= 20);
      // everything can be retried again without duplication
      await Promise.all(tasks.filter((t) => t.status === "FAILED").slice(0, 10).map((t) => rt.retryTask(t.id)));
      await rt.waitForIdle();
      assert.equal((await rt.bus.query({ type: "task.failed" })).length, 50);
    } finally {
      await cleanup();
    }
  });

  test("100 concurrent tool calls across tools complete with correct isolation", async () => {
    const dir = await tmpDir();
    const { registry, processes } = createDefaultToolRegistry();
    const calls = Array.from({ length: 100 }, (_, i) => {
      const args = i % 3 === 0 ? { command: `echo ${i}` } : i % 3 === 1 ? { path: `f${i}.txt`, content: `c${i}` } : { path: "." };
      const tool = i % 3 === 0 ? "terminal" : "filesystem";
      const action = i % 3 === 0 ? "execute" : i % 3 === 1 ? "write" : "list";
      return registry.execute(tool, { action, args }, { taskId: `t${i}`, agentId: "a", workdir: dir, timeoutMs: 20_000 });
    });
    const t0 = Date.now();
    const results = await Promise.all(calls);
    const ms = Date.now() - t0;
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok).map((r) => r.error)));
    for (let i = 0; i < 100; i += 3) assert.equal((results[i].data as { stdout: string }).stdout.trim(), String(i));
    for (let i = 1; i < 100; i += 3) assert.equal(await fsp.readFile(path.join(dir, `f${i}.txt`), "utf8"), `c${i}`);
    console.log(`# stress: 100 concurrent tool calls in ${ms}ms`);
    await processes.shutdown();
    await rmRetry(dir);
  });

  test("event throughput + replay: 5000 events through sqlite and file stores, ordering preserved", async () => {
    for (const [name, make] of [
      ["sqlite", async () => new SqlitePersistence(path.join(await tmpDir(), "e.db"))],
      ["file", async () => new FilePersistence(path.join(await tmpDir(), "store"))],
    ] as const) {
      const store = await make();
      await store.init();
      const bus = new EventBus(store);
      let received = 0;
      bus.subscribe(() => { received++; });
      const t0 = Date.now();
      await Promise.all(Array.from({ length: 5000 }, (_, i) => bus.emit({ taskId: `t${i % 50}`, agentId: null, type: i % 2 ? "tool.completed" : "tool.started", data: { i } })));
      const writeMs = Date.now() - t0;
      assert.equal(received, 5000);
      assert.equal(await store.countEvents(), 5000);
      const t1 = Date.now();
      const seqs: number[] = [];
      const n = await bus.replay({ taskId: "t7" }, (e) => { seqs.push(e.seq); });
      assert.equal(n, 100);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "replay preserves order");
      const page = await store.queryEvents({ limit: 10 });
      assert.equal(page.length, 10);
      assert.ok(page[9].id! > page[0].id!);
      console.log(`# stress(${name}): 5000 events written in ${writeMs}ms (${((5000 / writeMs) * 1000).toFixed(0)} ev/s), replay 100 in ${Date.now() - t1}ms`);
      await store.close();
    }
  });
});
