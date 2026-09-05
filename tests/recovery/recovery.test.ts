import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { AgentRuntime } from "@/agentos/runtime";
import { SqlitePersistence } from "@/agentos/persistence";
import { tmpDir, rmRetry } from "../helpers";

const WORKER = path.join(process.cwd(), "tests", "recovery", "worker.ts");

function startWorker(dir: string, mode = "run") {
  // run node directly (not the tsx wrapper binary) so SIGKILL hits the real worker process
  const child = spawn(process.execPath, ["--import", "tsx", WORKER, dir, mode], { stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c.toString()));
  child.stderr.on("data", () => undefined);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, stdout: () => stdout };
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, what: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}

describe("crash recovery", () => {
  test("SIGKILL mid-task → restart → recoverAll resumes from checkpoint; completed steps are not re-executed", async () => {
    const dir = await tmpDir("agentos-recovery-");
    const dbFile = path.join(dir, ".agentos", "agentos.db");
    const w = startWorker(dir);
    // wait until the checkpoint shows s1 completed and s2 in flight
    await waitFor(async () => {
      try {
        const log = await fsp.readFile(path.join(dir, "steps.log"), "utf8");
        return log.includes("s2");
      } catch {
        return false;
      }
    }, 20_000, "s2 to start");
    await new Promise((r) => setTimeout(r, 400)); // let the s1 checkpoint land
    w.child.kill("SIGKILL");
    assert.notEqual(await w.exited, 0);
    const taskId = JSON.parse(w.stdout().split("\n").find((l) => l.includes("taskId"))!).taskId as string;

    // --- restart: new process/runtime on the same store
    const rt = await AgentRuntime.create({ rootDir: dir, persistence: new SqlitePersistence(dbFile), model: null, controlPollMs: 0 });
    try {
      const before = rt.getTask(taskId)!;
      assert.equal(before.status, "EXECUTING", "task must still look active in the store after the crash");
      const cp = await rt.persistence.loadCheckpoint(taskId);
      assert.ok(cp, "checkpoint must exist");
      assert.equal(cp!.completedSteps.filter((s) => s.ok).length, 1);
      assert.deepEqual(rt.interruptedTasks().map((t) => t.id), [taskId]);
      const doc = await rt.doctor();
      assert.match(doc.checks.find((c) => c.name === "interrupted")!.detail, /1 task/);

      const r = await rt.recoverAll();
      assert.deepEqual(r.recovered, [taskId]);
      const done = await rt.waitForTask(taskId);
      assert.equal(done.status, "COMPLETED", done.error);
      const log = (await fsp.readFile(path.join(dir, "steps.log"), "utf8")).trim().split("\n");
      assert.equal(log.filter((l) => l === "s1").length, 1, "s1 must not be re-executed");
      assert.equal(log.filter((l) => l === "s3").length, 1);
      assert.ok(log.filter((l) => l === "s2").length >= 1);
      assert.equal(log.at(-1), "s3");
      const types = (await rt.bus.query({ taskId })).map((e) => e.type);
      assert.ok(types.includes("task.recovering"));
      assert.ok(types.includes("task.resumed"));
      assert.equal(types.filter((t) => t === "task.completed").length, 1, "no duplicate completion");
      assert.equal(await rt.persistence.loadCheckpoint(taskId), null);
    } finally {
      await rt.close();
      await rmRetry(dir);
    }
  });

  test("recovery via a fresh CLI-style process (worker recover mode) and repeated kills", async () => {
    const dir = await tmpDir("agentos-recovery2-");
    const w = startWorker(dir);
    await waitFor(async () => fsp.readFile(path.join(dir, "steps.log"), "utf8").then((l) => l.includes("s2")).catch(() => false), 20_000, "s2");
    await new Promise((r) => setTimeout(r, 300));
    w.child.kill("SIGKILL");
    await w.exited;
    // second kill during recovery
    const r1 = startWorker(dir, "recover");
    await new Promise((r) => setTimeout(r, 2500));
    r1.child.kill("SIGKILL");
    await r1.exited;
    const r2 = startWorker(dir, "recover");
    assert.equal(await r2.exited, 0, r2.stdout());
    const rt = await AgentRuntime.create({ rootDir: dir, persistence: new SqlitePersistence(path.join(dir, ".agentos", "agentos.db")), model: null, controlPollMs: 0 });
    try {
      const tasks = rt.listTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].status, "COMPLETED", tasks[0].error);
      const log = (await fsp.readFile(path.join(dir, "steps.log"), "utf8")).trim().split("\n");
      assert.equal(log.filter((l) => l === "s1").length, 1);
      assert.equal(log.filter((l) => l === "s3").length, 1);
    } finally {
      await rt.close();
      await rmRetry(dir);
    }
  });

  test("recovery edge cases: missing workdir → FAILED; no checkpoint → restarted; terminal checkpoint ignored", async () => {
    const base = await tmpDir("agentos-recovery3-");
    const work = path.join(base, "work");
    await fsp.mkdir(work);
    const p = new SqlitePersistence(path.join(base, "db.sqlite"));
    const rt = await AgentRuntime.create({ rootDir: base, dataDir: path.join(base, ".agentos"), persistence: p, model: null, controlPollMs: 0 });
    try {
      const t = await rt.createTask({ title: "gone", goal: "run: echo hi", workdir: "work" });
      // fabricate a crash state: task EXECUTING with checkpoint pointing to a workdir we then delete
      t.status = "EXECUTING";
      await p.saveTask(t);
      await p.saveCheckpoint({ taskId: t.id, version: 3, phase: "EXECUTING", attempt: 0, completedSteps: [], messages: [], verification: [], workdir: work, usage: t.usage, progress: 20, savedAt: "" });
      await rmRetry(work);
      const r = await rt.recoverTask(t.id);
      assert.equal(r.task.status, "FAILED");
      assert.match(r.task.error!, /workdir missing/);

      const t2 = await rt.createTask({ title: "no-cp", goal: "run: echo restart" });
      t2.status = "PLANNING";
      await p.saveTask(t2);
      const r2 = await rt.recoverTask(t2.id);
      assert.match(r2.warnings[0], /no checkpoint/);
      assert.equal((await rt.waitForTask(t2.id)).status, "COMPLETED");

      const t3 = await rt.createTask({ title: "done-cp", goal: "run: echo x" });
      await p.saveCheckpoint({ taskId: t3.id, version: 9, phase: "COMPLETED", attempt: 0, completedSteps: [], messages: [], verification: [], workdir: base, usage: t3.usage, progress: 100, savedAt: "" });
      const r3 = await rt.recoverTask(t3.id);
      assert.match(r3.warnings[0], /terminal phase/);
      await assert.rejects(() => rt.recoverTask("missing-id"), /not found/);
    } finally {
      await rt.close();
      await rmRetry(base);
    }
  });

  test("cross-process control channel: pause file stops a running task with a checkpoint, resume completes it", async () => {
    const dir = await tmpDir("agentos-control-");
    const rt = await AgentRuntime.create({ rootDir: dir, persistence: "sqlite", model: null, controlPollMs: 100 });
    try {
      const t = await rt.createTask({ title: "ctl", goal: "n/a", steps: [
        { id: "a", tool: "terminal", action: "execute", args: { command: "echo a >> c.log" } },
        { id: "b", tool: "terminal", action: "execute", args: { command: "echo b >> c.log; sleep 2" } },
        { id: "c", tool: "terminal", action: "execute", args: { command: "echo c >> c.log" } },
      ] });
      await rt.startTask(t.id);
      // pause must land while step "b" (sleep 2) is in flight: "a" is checkpointed
      // by then, "b" is not. Poll for the side effect instead of a fixed sleep —
      // a fixed 500ms races runtime/spawn startup on loaded machines.
      const pauseDeadline = Date.now() + 15_000;
      for (;;) {
        const lines = (await fsp.readFile(path.join(dir, "c.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
        if (lines.includes("b")) break;
        if (Date.now() > pauseDeadline) throw new Error(`step b never wrote its side effect; log=${JSON.stringify(lines)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      // simulate another process writing the control file
      const other = await AgentRuntime.create({ rootDir: dir, persistence: "memory", model: null, controlPollMs: 0 });
      await other.sendControl(t.id, "pause");
      await other.close();
      const paused = await rt.waitForTask(t.id);
      assert.equal(paused.status, "PAUSED");
      const types = (await rt.bus.query({ taskId: t.id })).map((e) => e.type);
      assert.ok(types.includes("task.control"));
      await rt.resumeTask(t.id);
      assert.equal((await rt.waitForTask(t.id)).status, "COMPLETED");
      const log = (await fsp.readFile(path.join(dir, "c.log"), "utf8")).trim().split("\n");
      assert.equal(log.filter((l) => l === "a").length, 1);
      assert.equal(log.at(-1), "c");
    } finally {
      await rt.close();
      await rmRetry(dir);
    }
  });
});
