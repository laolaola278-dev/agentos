import path from "node:path";
import { AgentRuntime } from "@/agentos/runtime";
import { MemoryPersistence } from "@/agentos/persistence";
import type { Checkpoint } from "@/agentos/types";
import { tmpDir } from "../helpers";

class P extends MemoryPersistence {
  fail = 2;
  n = 0;
  override async saveCheckpoint(cp: Checkpoint): Promise<void> {
    this.n++;
    if (this.n <= this.fail) {
      console.log(`[inject] failing saveCheckpoint #${this.n} (phase=${cp.phase}, steps=${cp.completedSteps.length})`);
      throw new Error("simulated transient storage failure (saveCheckpoint)");
    }
    return super.saveCheckpoint(cp);
  }
}

async function main() {
  const dir = await tmpDir("agentos-diag-");
  const p = new P();
  const rt = await AgentRuntime.create({ rootDir: dir, dataDir: path.join(dir, ".agentos"), persistence: p, model: null, controlPollMs: 0 });
  const t = await rt.createTask({
    title: "side-effects",
    goal: "n/a",
    steps: [
      { id: "a", tool: "terminal", action: "execute", args: { command: "echo a >> side.log" } },
      { id: "b", tool: "terminal", action: "execute", args: { command: "echo b >> side.log" } },
    ],
  });
  const done = await rt.runTask(t.id);
  console.log("status:", done.status, "error:", done.error);
  const events = await rt.bus.query({ taskId: t.id });
  console.log(
    "events:",
    events.map((e) => e.type).join(", "),
  );
  console.log("attempt:", done.attempt, "usage:", JSON.stringify(done.usage));
  await rt.close();

}
void main();
