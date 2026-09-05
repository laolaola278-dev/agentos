import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rmRetry } from "../helpers";

/**
 * PostgreSQL regression suite (dashboard path). Runs against a real server when
 * TEST_DATABASE_URL is set, e.g.
 *   TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:5432/agentos_test npm run test:integration
 * The server is expected to be empty/ephemeral; tables are created by init().
 */
const url = process.env.TEST_DATABASE_URL;

test("PostgreSQL persistence end-to-end", { skip: !url && "TEST_DATABASE_URL not set" }, async () => {
  process.env.DATABASE_URL = url;
  const [{ db }] = await Promise.all([import("@/db")]);
  const { PgPersistence } = await import("@/agentos/persistence-pg");
  const { AgentRuntime } = await import("@/agentos/runtime");

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "agentos-pg-"));
  const store = new PgPersistence(db);
  // idempotent start: wipe leftovers from previous runs
  await store.init();
  for (const table of ["agentos_events", "agentos_checkpoints", "agentos_tasks"]) {
    await db.execute(`DELETE FROM ${table}` as never);
  }

  const rt = await AgentRuntime.create({
    rootDir: dir,
    dataDir: path.join(dir, ".agentos"),
    persistence: store,
    model: null,
    controlPollMs: 0,
    jsonlMirror: true,
  });
  try {
    // full lifecycle round-trip through PostgreSQL
    const task = await rt.createTask({ title: "pg regression", goal: "write pg.txt: from postgres\ncheck contains pg.txt: postgres" });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", done.error);

    const events = await rt.bus.query({ taskId: task.id });
    assert.ok(events.length >= 10, `events persisted (${events.length})`);
    assert.ok(events.some((e) => e.type === "task.completed"));
    assert.ok(events.some((e) => e.type === "review.completed"));
    // completed tasks leave no checkpoint behind
    assert.equal(await store.loadCheckpoint(task.id), null);

    // a second runtime instance over the same store sees everything (dashboard boot path)
    const rt2 = await AgentRuntime.create({ rootDir: dir, dataDir: path.join(dir, ".agentos"), persistence: new PgPersistence(db), model: null, controlPollMs: 0 });
    try {
      const seen = await rt2.loadTask(task.id);
      assert.equal(seen?.status, "COMPLETED");
      const reopened = await rt2.bus.query({ taskId: task.id, typePrefix: "task." });
      assert.ok(reopened.some((e) => e.type === "task.completed"), "second instance replays persisted events");
      assert.equal(rt2.interruptedTasks().length, 0, "nothing to recover");
    } finally {
      await rt2.close();
    }

    // checkpoint round-trip on the raw store (recovery path)
    const draft = await rt.createTask({ title: "pg checkpoint", goal: "n/a" });
    await store.saveCheckpoint({
      taskId: draft.id,
      version: 1,
      phase: "EXECUTING",
      attempt: 0,
      completedSteps: [],
      messages: [],
      verification: [],
      acceptance: [],
      workdir: dir,
      usage: { toolCalls: 0, tokens: 0, retries: 0, fixes: 0, elapsedMs: 0 },
      progress: 20,
      savedAt: new Date().toISOString(),
    });
    const loaded = await store.loadCheckpoint(draft.id);
    assert.equal(loaded?.phase, "EXECUTING");
    await store.deleteCheckpoint(draft.id);
    assert.equal(await store.loadCheckpoint(draft.id), null);
  } finally {
    await rt.close();
    await rmRetry(dir);
  }
});
