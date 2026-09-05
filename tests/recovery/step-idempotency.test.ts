import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { AgentRuntime } from "@/agentos/runtime";
import { MemoryPersistence } from "@/agentos/persistence";
import type { Checkpoint } from "@/agentos/types";
import { tmpDir, rmRetry } from "../helpers";

/**
 * Side-effect idempotency across a task-level retry.
 *
 * A task whose step has already produced an external side effect (appending to
 * a file, creating a resource, sending a request) must not re-run that step
 * when the harness retries the task. A transient persistence failure must be
 * absorbed as a warning, not promoted into "start the whole task over".
 */
class FaultInjectingPersistence extends MemoryPersistence {
  /** Number of leading saveCheckpoint calls to fail before succeeding. */
  failCheckpointSaves = 0;
  checkpointSaveCalls = 0;

  override async saveCheckpoint(cp: Checkpoint): Promise<void> {
    this.checkpointSaveCalls++;
    if (this.checkpointSaveCalls <= this.failCheckpointSaves) {
      throw new Error("simulated transient storage failure (saveCheckpoint)");
    }
    return super.saveCheckpoint(cp);
  }
}

async function makeRuntime(dir: string, persistence: MemoryPersistence) {
  return AgentRuntime.create({ rootDir: dir, dataDir: path.join(dir, ".agentos"), persistence, model: null, controlPollMs: 0 });
}

describe("step idempotency across retries", () => {
  test("a transient checkpoint-save failure must not re-execute a completed step", async () => {
    const dir = await tmpDir("agentos-idempotency-");
    const p = new FaultInjectingPersistence();
    // The first save lands in PLANNING; fail the one right after step "a"
    // completes so the harness is forced to deal with a lost checkpoint while
    // the step's side effect has already happened.
    p.failCheckpointSaves = 2;
    const rt = await makeRuntime(dir, p);
    try {
      const t = await rt.createTask({
        title: "side-effects",
        goal: "n/a",
        steps: [
          { id: "a", tool: "terminal", action: "execute", args: { command: "echo a >> side.log" } },
          { id: "b", tool: "terminal", action: "execute", args: { command: "echo b >> side.log" } },
        ],
      });
      await rt.runTask(t.id);
      const log = (await fsp.readFile(path.join(dir, "side.log"), "utf8")).trim().split("\n");
      const events = (await rt.bus.query({ taskId: t.id })).map((e) => e.type);
      // The invariant under test: each step's side effect appears exactly once.
      assert.equal(
        log.filter((l) => l === "a").length,
        1,
        `step "a" must run exactly once; log=${JSON.stringify(log)} events=${JSON.stringify(events)}`,
      );
    } finally {
      await rt.close();
      await rmRetry(dir);
    }
  });
});
