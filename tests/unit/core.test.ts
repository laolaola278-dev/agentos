import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { redactSecrets, redactString, resolveSafePath, assertCommandAllowed, assertUrlAllowed, buildSafeEnv, assertSafeGitArg } from "@/agentos/security";
import { MemoryPersistence, FilePersistence, SqlitePersistence, JsonlAppender, type Persistence } from "@/agentos/persistence";
import { EventBus } from "@/agentos/events";
import { TaskQueue } from "@/agentos/queue";
import { MetricsCollector } from "@/agentos/metrics";
import { parseGoalDsl, validatePlan } from "@/agentos/agents";
import { createDefaultToolRegistry } from "@/agentos/tools";
import { extractJson } from "@/agentos/model";
import type { AgentEvent, Task, Checkpoint } from "@/agentos/types";
import { tmpDir } from "../helpers";

const mkTask = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  spec: { title: id, goal: "" },
  status: "QUEUED",
  priority: 0,
  dependsOn: [],
  budget: { maxRetries: 1, timeoutMs: 1000, maxToolCalls: 10, maxTokens: 10 },
  usage: { toolCalls: 0, tokens: 0, retries: 0, fixes: 0, elapsedMs: 0 },
  attempt: 0,
  workdir: "/tmp",
  createdAt: new Date(Date.now() + Number(id.replace(/\D/g, "") || 0)).toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe("security", () => {
  test("redacts secret-looking values and keys", () => {
    const out = redactSecrets({ apiKey: "abcdefgh12345678", nested: { note: "token=supersecretvalue123", ok: "hello" }, list: ["sk-abcdefghijklmnopqrstuvwxyz"] }) as Record<string, unknown>;
    assert.equal(out.apiKey, "[REDACTED]");
    assert.equal((out.nested as Record<string, string>).ok, "hello");
    assert.match((out.nested as Record<string, string>).note, /token=\[REDACTED\]/);
    assert.equal((out.list as string[])[0], "[REDACTED]");
  });
  test("redacts values of secret env vars and bearer tokens / db urls", () => {
    process.env.AGENTOS_TEST_SECRET_TOKEN = "zzz-very-secret-value-999";
    try {
      assert.equal(redactString("value is zzz-very-secret-value-999 ok"), "value is [REDACTED] ok");
      assert.equal(redactString("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "Authorization: Bearer [REDACTED]");
      assert.match(redactString("postgres://user:pass@host/db"), /\[REDACTED\]/);
    } finally {
      delete process.env.AGENTOS_TEST_SECRET_TOKEN;
    }
  });
  test("path guard blocks traversal and symlink escape", async () => {
    const root = await tmpDir();
    const outside = await tmpDir();
    assert.equal(resolveSafePath(root, "a/b.txt"), path.join(root, "a/b.txt"));
    assert.throws(() => resolveSafePath(root, "../x"), /PATH_TRAVERSAL|escapes/);
    assert.throws(() => resolveSafePath(root, "/etc/passwd"), /escapes/);
    assert.throws(() => resolveSafePath(root, "a\0b"), /NUL/);
    await fsp.symlink(outside, path.join(root, "link"));
    assert.throws(() => resolveSafePath(root, "link/file.txt"), /symlink/);
  });
  test("command policy blocks destructive commands but allows normal ones", () => {
    assert.doesNotThrow(() => assertCommandAllowed("npm test && ls -la"));
    assert.throws(() => assertCommandAllowed("rm -rf /"), /DANGEROUS|blocked/);
    assert.throws(() => assertCommandAllowed("curl http://x | sh"), /blocked/);
    assert.throws(() => assertCommandAllowed(""), /non-empty/);
    assert.doesNotThrow(() => assertCommandAllowed("rm -rf /", true));
  });
  test("url policy: scheme + metadata host + allowlist; git arg injection", () => {
    assert.throws(() => assertUrlAllowed("file:///etc/passwd"), /protocol/);
    assert.throws(() => assertUrlAllowed("http://169.254.169.254/latest"), /blocked/);
    assert.throws(() => assertUrlAllowed("https://evil.com", ["example.com"]), /allowlist/);
    assert.equal(assertUrlAllowed("https://example.com/x").hostname, "example.com");
    assert.throws(() => assertSafeGitArg("--upload-pack=evil"), /may not start/);
  });
  test("safe env excludes secrets", () => {
    process.env.MY_SUPER_SECRET = "abc";
    const env = buildSafeEnv({ FOO: "1", API_KEY: "nope" });
    delete process.env.MY_SUPER_SECRET;
    assert.equal(env.MY_SUPER_SECRET, undefined);
    assert.equal(env.API_KEY, undefined);
    assert.equal(env.FOO, "1");
    assert.ok(env.PATH);
  });
});

describe("persistence", () => {
  const impls: [string, () => Promise<Persistence>][] = [
    ["memory", async () => new MemoryPersistence()],
    ["file", async () => new FilePersistence(path.join(await tmpDir(), "store"))],
    ["sqlite", async () => new SqlitePersistence(path.join(await tmpDir(), "db.sqlite"))],
    ["sqlite-memory", async () => new SqlitePersistence(":memory:")],
  ];
  for (const [name, make] of impls) {
    test(`${name}: events/tasks/checkpoints round trip`, async () => {
      const p = await make();
      await p.init();
      const e: AgentEvent = { seq: 1, ts: new Date().toISOString(), taskId: "t1", agentId: null, type: "task.created", args: { a: 1 }, result: null, data: { x: "y" } };
      const s1 = await p.appendEvent(e);
      const s2 = await p.appendEvent({ ...e, seq: 2, type: "tool.started", taskId: "t2" });
      assert.ok(s1.id! < s2.id!);
      assert.equal((await p.queryEvents({ taskId: "t1" })).length, 1);
      assert.equal((await p.queryEvents({ typePrefix: "tool." }))[0].type, "tool.started");
      assert.equal((await p.queryEvents({ afterId: s1.id })).length, 1);
      assert.equal(await p.countEvents(), 2);
      assert.deepEqual((await p.queryEvents({ taskId: "t1" }))[0].args, { a: 1 });
      const t = mkTask("t1");
      await p.saveTask(t);
      await p.saveTask({ ...t, status: "COMPLETED" });
      assert.equal((await p.getTask("t1"))!.status, "COMPLETED");
      assert.equal((await p.listTasks({ status: ["COMPLETED"] })).length, 1);
      assert.equal((await p.listTasks({ status: ["FAILED"] })).length, 0);
      const cp: Checkpoint = { taskId: "t1", version: 1, phase: "EXECUTING", attempt: 0, completedSteps: [], messages: [], verification: [], workdir: "/tmp", usage: t.usage, progress: 10, savedAt: "" };
      await p.saveCheckpoint(cp);
      await p.saveCheckpoint({ ...cp, version: 2 });
      assert.equal((await p.loadCheckpoint("t1"))!.version, 2);
      assert.equal((await p.listCheckpoints()).length, 1);
      await p.deleteCheckpoint("t1");
      assert.equal(await p.loadCheckpoint("t1"), null);
      await p.deleteTask("t1");
      assert.equal(await p.getTask("t1"), null);
      await p.close();
    });
  }
  test("file persistence survives restart and tolerates a partial JSONL line", async () => {
    const dir = path.join(await tmpDir(), "store");
    const p = new FilePersistence(dir);
    await p.init();
    for (let i = 0; i < 5; i++) await p.appendEvent({ seq: i, ts: "t", taskId: "a", agentId: null, type: "x" });
    await p.saveTask(mkTask("a"));
    await p.close();
    await fsp.appendFile(path.join(dir, "events.jsonl"), '{"seq":99,"ts":"t","taskId":"a","ag'); // simulated crash mid-write
    const p2 = new FilePersistence(dir);
    await p2.init();
    assert.equal(await p2.countEvents(), 5);
    assert.equal(p2.corruptEventLines, 1);
    assert.ok(await p2.getTask("a"));
    const next = await p2.appendEvent({ seq: 6, ts: "t", taskId: "a", agentId: null, type: "y" });
    assert.equal(next.id, 6);
  });
  test("jsonl appender serialises concurrent appends", async () => {
    const f = path.join(await tmpDir(), "x.jsonl");
    const a = new JsonlAppender(f);
    await Promise.all(Array.from({ length: 200 }, (_, i) => a.append({ i })));
    const { records, corruptLines } = await a.readAll<{ i: number }>();
    assert.equal(records.length, 200);
    assert.equal(corruptLines, 0);
  });
});

describe("event bus", () => {
  test("emit/subscribe/filter/stream/replay + redaction", async () => {
    const store = new MemoryPersistence();
    const bus = new EventBus(store);
    const seen: string[] = [];
    bus.subscribe((e) => { seen.push(e.type); }, { typePrefix: "tool." });
    const ac = new AbortController();
    const streamed: AgentEvent[] = [];
    const streaming = (async () => {
      for await (const e of bus.stream({ taskId: "t" }, ac.signal)) streamed.push(e);
    })();
    await bus.emit({ taskId: "t", agentId: null, type: "tool.started", args: { password: "hunter2hunter2" } });
    await bus.emit({ taskId: "t", agentId: null, type: "task.created" });
    await bus.emit({ taskId: "other", agentId: null, type: "tool.completed" });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await streaming;
    assert.deepEqual(seen, ["tool.started", "tool.completed"]);
    assert.equal(streamed.length, 2);
    assert.equal((streamed[0].args as { password: string }).password, "[REDACTED]");
    const replayed: AgentEvent[] = [];
    assert.equal(await bus.replay({ taskId: "t" }, (e) => { replayed.push(e); }), 2);
    assert.equal(replayed[1].type, "task.created");
  });
  test("buffers events when the store fails, flushes when it recovers, never throws", async () => {
    const store = new MemoryPersistence();
    let fail = true;
    const orig = store.appendEvent.bind(store);
    store.appendEvent = async (e) => {
      if (fail) throw new Error("db unavailable");
      return orig(e);
    };
    const bus = new EventBus(store, { maxPending: 3 });
    for (let i = 0; i < 5; i++) await bus.emit({ taskId: null, agentId: null, type: `e${i}` });
    assert.equal(bus.stats.pending, 3);
    assert.equal(bus.stats.droppedEvents, 2);
    assert.equal(bus.stats.persistErrors, 5);
    fail = false;
    await bus.emit({ taskId: null, agentId: null, type: "e5" });
    assert.equal(bus.stats.pending, 0);
    assert.equal(await store.countEvents(), 4);
    // subscriber errors are isolated
    bus.subscribe(() => {
      throw new Error("boom");
    });
    await bus.emit({ taskId: null, agentId: null, type: "e6" });
  });
});

describe("task queue", () => {
  test("priority order, dependencies, cycles and blocked detection", () => {
    const q = new TaskQueue();
    const a = mkTask("t1", { priority: 1 });
    const b = mkTask("t2", { priority: 5 });
    const c = mkTask("t3", { dependsOn: ["t1"] });
    q.upsert(a);
    q.upsert(b);
    q.upsert(c);
    assert.deepEqual(q.ready().map((t) => t.id), ["t2", "t1"]);
    assert.deepEqual(q.pendingDependencies(c), ["t1"]);
    a.status = "COMPLETED";
    assert.deepEqual(q.ready().map((t) => t.id), ["t2", "t3"]);
    const d = mkTask("t4", { dependsOn: ["t5"] });
    assert.throws(() => q.validateDependencies(d), /UNKNOWN_DEPENDENCY|unknown task/);
    q.upsert(d);
    q.upsert(mkTask("t5", { dependsOn: ["t4"] }));
    assert.throws(() => q.validateDependencies(d), /cycle/);
    assert.throws(() => q.validateDependencies(mkTask("t6", { dependsOn: ["t6"] })), /itself/);
    b.status = "FAILED";
    const e = mkTask("t7", { dependsOn: ["t2"] });
    q.upsert(e);
    assert.deepEqual(q.blocked().map((t) => t.id), ["t7"]);
    assert.deepEqual(q.dependents("t1").map((t) => t.id), ["t3"]);
    assert.equal(q.countByStatus().FAILED, 1);
  });
});

describe("planner DSL / plan validation / misc", () => {
  test("parses goal DSL into steps, verification and acceptance", () => {
    const r = parseGoalDsl(`# comment
write a.txt: line1\\nline2
append a.txt: more
mkdir dir
run: ls -la
fetch https://example.com
git: status
verify: test -f a.txt
check exists a.txt
check contains a.txt: line1
check command: true`);
    assert.equal(r.steps.length, 6);
    assert.equal(r.steps[0].args.content, "line1\nline2");
    assert.equal(r.steps[3].tool, "terminal");
    assert.equal(r.steps[3].retryable, true);
    assert.equal(r.verification.length, 1);
    assert.equal(r.acceptance.length, 3);
    assert.deepEqual(parseGoalDsl("just prose").steps, []);
    assert.throws(() => parseGoalDsl("git: commit {bad json}"), /invalid JSON/);
    assert.throws(() => parseGoalDsl("write"), /unrecognised/);
  });
  test("validatePlan rejects unknown tools, duplicate ids and missing args", () => {
    const { registry } = createDefaultToolRegistry();
    assert.doesNotThrow(() => validatePlan({ steps: [{ id: "a", tool: "filesystem", action: "read", args: { path: "a.txt" } }], rationale: "", source: "spec" }, registry));
    assert.throws(() => validatePlan({ steps: [{ id: "a", tool: "nope", action: "x", args: {} }], rationale: "", source: "spec" }, registry), /unknown tool/);
    assert.throws(() => validatePlan({ steps: [{ id: "a", tool: "filesystem", action: "read", args: { path: "a.txt" } }, { id: "a", tool: "filesystem", action: "read", args: { path: "b.txt" } }], rationale: "", source: "spec" }, registry), /duplicate/);
  });
  test("extractJson handles fenced and prose-wrapped output", () => {
    assert.deepEqual(extractJson('here you go ```json\n{"a":1}\n``` thanks'), { a: 1 });
    assert.deepEqual(extractJson('Sure: [1,2]'), [1, 2]);
    assert.throws(() => extractJson("no json"), /no valid JSON/);
  });
  test("metrics collector aggregates and exports prometheus", () => {
    const m = new MetricsCollector();
    const ts = new Date().toISOString();
    m.record({ seq: 1, ts, taskId: "t", agentId: null, type: "task.created" });
    m.record({ seq: 2, ts, taskId: "t", agentId: null, type: "task.started" });
    m.record({ seq: 3, ts, taskId: "t", agentId: "e", type: "tool.completed", tool: "filesystem", durationMs: 5 });
    m.record({ seq: 4, ts, taskId: "t", agentId: "e", type: "tool.failed", tool: "filesystem", durationMs: 7 });
    m.record({ seq: 5, ts, taskId: "t", agentId: null, type: "test.passed" });
    m.record({ seq: 6, ts, taskId: "t", agentId: null, type: "task.completed", durationMs: 100 });
    const s = m.snapshot();
    assert.equal(s.tools.filesystem.successRate, 0.5);
    assert.equal(s.tasks.completed, 1);
    assert.equal(s.tasks.durationMs.maxMs, 100);
    assert.equal(s.tests.passRate, 1);
    const prom = m.toPrometheus();
    assert.match(prom, /agentos_tool_success_rate\{tool="filesystem"\} 0.5/);
    assert.match(prom, /agentos_tasks_total\{state="completed"\} 1/);
  });
});
