/* AgentOS benchmark — real numbers, written to BENCHMARK.md. Run: npm run bench */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AgentRuntime } from "@/agentos/runtime";
import { SqlitePersistence, FilePersistence, MemoryPersistence } from "@/agentos/persistence";
import { EventBus } from "@/agentos/events";
import { createDefaultToolRegistry } from "@/agentos/tools";

const N = Number(process.env.BENCH_TASKS ?? 300);
const results: string[] = [];
const log = (s: string) => {
  console.log(s);
  results.push(s);
};
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

async function tmp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "agentos-bench-"));
}

async function benchStartup() {
  const dir = await tmp();
  const t0 = performance.now();
  const rt = await AgentRuntime.create({ rootDir: dir, persistence: "sqlite", model: null, controlPollMs: 0 });
  const cold = performance.now() - t0;
  await rt.close();
  const t1 = performance.now();
  const rt2 = await AgentRuntime.create({ rootDir: dir, persistence: "sqlite", model: null, controlPollMs: 0 });
  const warm = performance.now() - t1;
  await rt2.close();
  log(`| Startup (sqlite) | cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms |`);
  await fsp.rm(dir, { recursive: true, force: true });
}

async function benchTasks(persistence: "memory" | "sqlite" | "file", concurrency: number) {
  const dir = await tmp();
  const rt = await AgentRuntime.create({ rootDir: dir, persistence, model: null, controlPollMs: 0, concurrency, heartbeatMs: 60_000 });
  const memBefore = process.memoryUsage();
  const t0 = performance.now();
  const ids: string[] = [];
  for (let i = 0; i < N; i++) ids.push((await rt.createTask({ title: `b${i}`, goal: `write out/${i}.txt: ${i}\ncheck exists out/${i}.txt` })).id);
  for (const id of ids) await rt.startTask(id);
  await rt.waitForIdle();
  const ms = performance.now() - t0;
  const memAfter = process.memoryUsage();
  const ok = ids.filter((id) => rt.getTask(id)!.status === "COMPLETED").length;
  const events = await rt.persistence.countEvents();
  log(`| ${N} tasks, ${persistence}, concurrency ${concurrency} | ${ms.toFixed(0)} ms → ${((ok / ms) * 1000).toFixed(1)} tasks/s, ${ok}/${N} completed, ${events} events, heap Δ ${mb(memAfter.heapUsed - memBefore.heapUsed)}, RSS ${mb(memAfter.rss)} |`);
  await rt.close();
  await fsp.rm(dir, { recursive: true, force: true });
}

async function benchEvents() {
  for (const [name, make] of [
    ["memory", async () => new MemoryPersistence()],
    ["sqlite", async () => new SqlitePersistence(path.join(await tmp(), "e.db"))],
    ["file/jsonl", async () => new FilePersistence(path.join(await tmp(), "store"))],
  ] as const) {
    const store = await make();
    await store.init();
    const bus = new EventBus(store);
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) await bus.emit({ taskId: `t${i % 100}`, agentId: null, type: "tool.completed", data: { i } });
    const seqMs = performance.now() - t0;
    const t1 = performance.now();
    await Promise.all(Array.from({ length: 10_000 }, (_, i) => bus.emit({ taskId: `t${i % 100}`, agentId: null, type: "tool.started", data: { i } })));
    const parMs = performance.now() - t1;
    const t2 = performance.now();
    const n = await bus.replay({}, () => undefined);
    const replayMs = performance.now() - t2;
    log(`| Events, ${name} | sequential ${((10_000 / seqMs) * 1000).toFixed(0)} ev/s, concurrent ${((10_000 / parMs) * 1000).toFixed(0)} ev/s, replay ${n} in ${replayMs.toFixed(0)} ms (${((n / replayMs) * 1000).toFixed(0)} ev/s) |`);
    await store.close();
  }
}

async function benchTools() {
  const dir = await tmp();
  const { registry, processes } = createDefaultToolRegistry();
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 200 }, (_, i) => registry.execute("filesystem", { action: "write", args: { path: `f${i}.txt`, content: "x" } }, { taskId: "b", agentId: "b", workdir: dir })));
  const fsMs = performance.now() - t0;
  const t1 = performance.now();
  await Promise.all(Array.from({ length: 100 }, () => registry.execute("terminal", { action: "execute", args: { command: "true" } }, { taskId: "b", agentId: "b", workdir: dir })));
  const shMs = performance.now() - t1;
  log(`| Tool calls | 200 concurrent filesystem.write in ${fsMs.toFixed(0)} ms (${((200 / fsMs) * 1000).toFixed(0)}/s); 100 concurrent terminal.execute in ${shMs.toFixed(0)} ms (${((100 / shMs) * 1000).toFixed(0)}/s) |`);
  await processes.shutdown();
  await fsp.rm(dir, { recursive: true, force: true });
}

async function benchRecovery() {
  const dir = await tmp();
  const dbFile = path.join(dir, ".agentos", "agentos.db");
  const rt = await AgentRuntime.create({ rootDir: dir, persistence: new SqlitePersistence(dbFile), model: null, controlPollMs: 0 });
  const t = await rt.createTask({ title: "rec", goal: "n/a", steps: [
    { id: "a", tool: "terminal", action: "execute", args: { command: "echo a >> r.log" } },
    { id: "b", tool: "terminal", action: "execute", args: { command: "sleep 5" } },
  ] });
  await rt.startTask(t.id);
  await new Promise((r) => setTimeout(r, 400));
  await rt.pauseTask(t.id); // simulate interruption with a persisted checkpoint
  await rt.close();
  const t0 = performance.now();
  const rt2 = await AgentRuntime.create({ rootDir: dir, persistence: new SqlitePersistence(dbFile), model: null, controlPollMs: 0 });
  const loaded = performance.now() - t0;
  const t1 = performance.now();
  const r = await rt2.recoverTask(t.id);
  const resumed = performance.now() - t1;
  log(`| Recovery | restart+load ${loaded.toFixed(0)} ms, checkpoint verify+resume ${resumed.toFixed(0)} ms (phase ${r.checkpoint?.phase}, ${r.checkpoint?.completedSteps.length} steps kept) |`);
  await rt2.cancelTask(t.id).catch(() => undefined);
  await rt2.close();
  await fsp.rm(dir, { recursive: true, force: true });
}

async function main() {
  log(`# BENCHMARK\n\nGenerated ${new Date().toISOString()} on ${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs (${os.cpus()[0]?.model.trim()}), Node ${process.version}, ${mb(os.totalmem())} RAM.\n`);
  log("All tasks are deterministic-planner tasks (1 filesystem write + acceptance check + full plan/execute/verify/review lifecycle, ~20 events each). No LLM calls.\n");
  log("| Benchmark | Result |\n|---|---|");
  await benchStartup();
  await benchTasks("memory", 16);
  await benchTasks("sqlite", 16);
  await benchTasks("sqlite", 4);
  await benchTasks("file", 16);
  await benchEvents();
  await benchTools();
  await benchRecovery();
  log("\nNotes: numbers are wall-clock from a single run inside the development sandbox and vary with disk/CPU. Re-run with `npm run bench` (env BENCH_TASKS to change task count).");
  await fsp.writeFile("BENCHMARK.md", results.join("\n") + "\n");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
