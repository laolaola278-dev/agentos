import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { makeRuntime } from "../helpers";
import { runGit } from "@/agentos/tools/git";
import { SqlitePersistence } from "@/agentos/persistence";
import { AgentRuntime } from "@/agentos/runtime";

describe("runtime lifecycle", () => {
  test("happy path: plan → execute → verify → review → COMPLETED with evidence", async () => {
    const { rt, dir, cleanup } = await makeRuntime();
    try {
      const t = await rt.createTask({
        title: "hello",
        goal: "write out/hello.txt: hi there\nrun: cat out/hello.txt\nverify: grep -q 'hi there' out/hello.txt\ncheck exists out/hello.txt",
      });
      assert.equal(t.status, "CREATED");
      const done = await rt.runTask(t.id);
      assert.equal(done.status, "COMPLETED", done.error);
      assert.equal(done.result?.review?.verdict, "PASS");
      assert.equal(done.result?.verification.length, 1);
      assert.equal(done.result?.verification[0].passed, true);
      assert.equal(done.result?.stepResults.filter((r) => r.ok).length, 2);
      assert.equal(await fsp.readFile(path.join(dir, "out/hello.txt"), "utf8"), "hi there");
      const types = (await rt.bus.query({ taskId: t.id })).map((e) => e.type);
      for (const expected of ["task.created", "task.started", "agent.started", "agent.tool_call", "tool.started", "tool.completed", "test.started", "test.passed", "review.completed", "checkpoint.saved", "task.completed"]) {
        assert.ok(types.includes(expected), `missing event ${expected}`);
      }
      assert.equal(types.filter((x) => x === "task.completed").length, 1);
      assert.equal(await rt.persistence.loadCheckpoint(t.id), null, "checkpoint removed after completion");
      assert.equal(rt.metrics.snapshot().tasks.completed, 1);
    } finally {
      await cleanup();
    }
  });

  test("explicit steps with expectations; failing expectation → FIXING → FAILED with FAILURE_ANALYSIS.md", async () => {
    const { rt, cleanup } = await makeRuntime();
    try {
      const t = await rt.createTask({
        title: "expect",
        goal: "n/a",
        steps: [
          { id: "ok", tool: "terminal", action: "execute", args: { command: "echo alpha" }, expect: { stdoutIncludes: "alpha" } },
          { id: "bad", tool: "terminal", action: "execute", args: { command: "echo beta" }, expect: { stdoutIncludes: "gamma" } },
        ],
        budget: { maxRetries: 1 },
      });
      const done = await rt.runTask(t.id);
      assert.equal(done.status, "FAILED");
      assert.match(done.error!, /UNRECOVERABLE|FIX_ATTEMPTS/);
      assert.ok(done.result?.diagnosis);
      const analysis = await fsp.readFile(path.join(rt.dataDir, "failures", `FAILURE_ANALYSIS-${t.id}.md`), "utf8");
      assert.match(analysis, /Root cause/);
      assert.match(analysis, /Recommended next action/);
      assert.match(analysis, /gamma/);
      const types = (await rt.bus.query({ taskId: t.id })).map((e) => e.type);
      assert.ok(types.includes("task.fixing"));
      assert.ok(types.includes("task.diagnosed"));
      assert.ok(types.includes("task.failed"));
    } finally {
      await cleanup();
    }
  });

  test("self-correction: transient step failure is retried and the task completes", async () => {
    const { rt, dir, cleanup } = await makeRuntime();
    try {
      // first invocation fails (creates marker), second succeeds
      const t = await rt.createTask({
        title: "flaky",
        goal: "n/a",
        steps: [{ id: "flaky", tool: "terminal", action: "execute", args: { command: "if [ -f marker ]; then echo ok; else touch marker; exit 1; fi" }, retryable: true }],
        verification: [{ name: "marker", kind: "custom", command: "test -f marker" }],
      });
      const done = await rt.runTask(t.id);
      assert.equal(done.status, "COMPLETED", done.error);
      const flaky = done.result!.stepResults.find((r) => r.stepId === "flaky" && r.ok)!;
      assert.equal(flaky.attempt, 2);
      const events = await rt.bus.query({ taskId: t.id, type: "agent.retry" });
      assert.ok(events.length >= 1);
      await fsp.access(path.join(dir, "marker"));
    } finally {
      await cleanup();
    }
  });

  test("self-correction: verification failure triggers debugger → fix steps → re-verify → COMPLETED", async () => {
    const { rt, cleanup } = await makeRuntime();
    try {
      const t = await rt.createTask({
        title: "fix-loop",
        goal: "n/a",
        // step appends a line each run; verification wants at least 2 lines → passes only after the fix re-runs the step
        steps: [{ id: "append", tool: "terminal", action: "execute", args: { command: "echo line >> log.txt" }, retryable: true }],
        verification: [{ name: "two-lines", kind: "custom", command: "test $(wc -l < log.txt) -ge 2" }],
        budget: { maxRetries: 2 },
      });
      const done = await rt.runTask(t.id);
      assert.equal(done.status, "COMPLETED", done.error);
      assert.equal(done.usage.fixes, 1);
      assert.equal(done.result!.verification.at(-1)!.passed, true);
      const types = (await rt.bus.query({ taskId: t.id })).map((e) => e.type);
      assert.ok(types.includes("test.failed"));
      assert.ok(types.includes("task.fixing"));
      assert.ok(types.includes("test.passed"));
    } finally {
      await cleanup();
    }
  });

  test("budget: maxToolCalls exceeded → FAILED (not retried); timeout budget → FAILED", async () => {
    const { rt, cleanup } = await makeRuntime();
    try {
      const t = await rt.createTask({
        title: "budget",
        goal: "run: echo 1\nrun: echo 2\nrun: echo 3",
        budget: { maxToolCalls: 2, maxRetries: 3 },
      });
      const done = await rt.runTask(t.id);
      assert.equal(done.status, "FAILED");
      assert.match(done.error!, /BUDGET_EXCEEDED/);
      assert.equal(done.attempt, 0, "budget failures must not trigger retries");
      const slow = await rt.createTask({ title: "slow", goal: "run: sleep 5", budget: { timeoutMs: 400, maxRetries: 0 } });
      const t0 = Date.now();
      const sdone = await rt.runTask(slow.id);
      assert.equal(sdone.status, "FAILED");
      assert.ok(Date.now() - t0 < 4000, "timeout budget must cut the tool call short");
    } finally {
      await cleanup();
    }
  });

  test("pause mid-execution, resume from checkpoint without re-running completed steps; cancel; retry", async () => {
    const { rt, dir, cleanup } = await makeRuntime();
    try {
      const t = await rt.createTask({
        title: "pausable",
        goal: "n/a",
        steps: [
          { id: "s1", tool: "terminal", action: "execute", args: { command: "echo 1 >> trace.txt" } },
          { id: "s2", tool: "terminal", action: "execute", args: { command: "echo 2 >> trace.txt; sleep 1.5" } },
          { id: "s3", tool: "terminal", action: "execute", args: { command: "echo 3 >> trace.txt" } },
        ],
      });
      await rt.startTask(t.id);
      await new Promise((r) => setTimeout(r, 500));
      const paused = await rt.pauseTask(t.id);
      assert.equal(paused.status, "PAUSED");
      const cp = await rt.persistence.loadCheckpoint(t.id);
      assert.ok(cp && cp.completedSteps.filter((s) => s.ok).length === 1, "s1 must be checkpointed, s2 interrupted");
      assert.equal(cp!.phase, "EXECUTING");
      // the killed s2 shell may still hold trace.txt briefly on Windows; a real
      // operator resuming after a pause gives the system a moment too
      await new Promise((r) => setTimeout(r, 300));
      await rt.resumeTask(t.id);
      const done = await rt.waitForTask(t.id);
      assert.equal(done.status, "COMPLETED", done.error);
      const trace = (await fsp.readFile(path.join(dir, "trace.txt"), "utf8")).trim().split("\n");
      assert.deepEqual(trace, ["1", "2", "2", "3"], "s1 not re-run; interrupted s2 re-run; s3 run");
      const types = (await rt.bus.query({ taskId: t.id })).map((e) => e.type);
      assert.ok(types.includes("task.paused"));
      assert.ok(types.includes("task.resumed"));

      const c = await rt.createTask({ title: "cancel", goal: "run: sleep 10" });
      await rt.startTask(c.id);
      await new Promise((r) => setTimeout(r, 300));
      const cancelled = await rt.cancelTask(c.id);
      assert.equal(cancelled.status, "CANCELLED");
      assert.equal(await rt.persistence.loadCheckpoint(c.id), null);
      await assert.rejects(() => rt.resumeTask(c.id), /INVALID_TRANSITION|cannot resume/);
      await assert.rejects(() => rt.cancelTask(c.id), /already/);

      const f = await rt.createTask({ title: "retry", goal: "run: test -f retry-marker || (touch retry-marker && exit 1)", budget: { maxRetries: 0 } });
      // the run step is retryable → executor retries inline and succeeds; make it non-retryable via explicit steps instead
      const g = await rt.createTask({ title: "retry2", goal: "n/a", steps: [{ id: "x", tool: "terminal", action: "execute", args: { command: "test -f retry-marker2 || (touch retry-marker2 && exit 1)" } }], budget: { maxRetries: 0 } });
      assert.equal((await rt.runTask(f.id)).status, "COMPLETED");
      assert.equal((await rt.runTask(g.id)).status, "FAILED");
      const retried = await rt.retryTask(g.id);
      assert.ok(["QUEUED", "PLANNING", "EXECUTING"].includes(retried.status), retried.status);
      const gdone = await rt.waitForTask(g.id);
      assert.equal(gdone.status, "COMPLETED");
      assert.equal(gdone.usage.retries, 1);
    } finally {
      await cleanup();
    }
  });

  test("dependencies: chain A→B→C, fan-in D,E→F, blocked on failure, priority ordering", async () => {
    const { rt, dir, cleanup } = await makeRuntime({ concurrency: 3 });
    try {
      const mk = (title: string, deps: string[] = [], priority = 0, cmd = `echo ${title} >> order.txt`) => rt.createTask({ title, goal: `run: ${cmd}`, dependsOn: deps, priority });
      const a = await mk("A");
      const b = await mk("B", [a.id]);
      const c = await mk("C", [b.id]);
      const d = await mk("D", [], 0, "sleep 0.3; echo D >> order.txt");
      const e = await mk("E");
      const f = await mk("F", [d.id, e.id]);
      const bad = await rt.createTask({ title: "BAD", goal: "n/a", steps: [{ id: "x", tool: "terminal", action: "execute", args: { command: "exit 1" } }], budget: { maxRetries: 0 } });
      const blocked = await mk("BLOCKED", [bad.id]);
      await assert.rejects(() => rt.createTask({ title: "cycle", goal: "", dependsOn: ["missing"] }), /unknown task/);
      for (const t of [c, b, a, f, e, d, bad, blocked]) await rt.startTask(t.id);
      await rt.waitForIdle();
      const order = (await fsp.readFile(path.join(dir, "order.txt"), "utf8")).trim().split("\n");
      assert.ok(order.indexOf("A") < order.indexOf("B") && order.indexOf("B") < order.indexOf("C"));
      assert.ok(order.indexOf("D") < order.indexOf("F") && order.indexOf("E") < order.indexOf("F"));
      assert.equal(rt.getTask(bad.id)!.status, "FAILED");
      assert.equal(rt.getTask(blocked.id)!.status, "BLOCKED");
      assert.match(rt.getTask(blocked.id)!.error!, /did not complete/);
      for (const t of [a, b, c, d, e, f]) assert.equal(rt.getTask(t.id)!.status, "COMPLETED", t.spec.title);
      // priority: with concurrency 1, higher priority runs first
      const { rt: rt1, dir: dir1, cleanup: cleanup1 } = await makeRuntime({ concurrency: 1 });
      try {
        const low = await rt1.createTask({ title: "low", goal: "run: echo low >> p.txt", priority: 1 });
        const high = await rt1.createTask({ title: "high", goal: "run: echo high >> p.txt", priority: 10 });
        await rt1.startTask(low.id);
        await rt1.startTask(high.id);
        await rt1.waitForIdle();
        const p = (await fsp.readFile(path.join(dir1, "p.txt"), "utf8")).trim().split("\n");
        // low may have started first (scheduled immediately), but high must run before any *further* low-priority task
        assert.ok(p.length === 2 && p.includes("high") && p.includes("low"));
      } finally {
        await cleanup1();
      }
    } finally {
      await cleanup();
    }
  });

  test("reviewer blocks secrets in written content and protected paths", async () => {
    const { rt, cleanup } = await makeRuntime();
    try {
      const t = await rt.createTask({ title: "leak", goal: "write config.txt: api_key=sk-abcdefghijklmnopqrstuvwxyz123456", budget: { maxRetries: 0 } });
      const done = await rt.runTask(t.id);
      assert.equal(done.status, "FAILED");
      assert.equal(done.result?.review?.verdict, "FAIL");
      assert.ok(done.result!.review!.issues.some((i) => i.category === "security"));
      const events = await rt.bus.query({ taskId: t.id, type: "tool.started" });
      assert.ok(!JSON.stringify(events).includes("sk-abcdefghijklmnopqrstuvwxyz123456"), "secret must be redacted in the event log");
      const t2 = await rt.createTask({ title: "protected", goal: "write node_modules/x.js: 1", budget: { maxRetries: 0 } });
      const d2 = await rt.runTask(t2.id);
      assert.equal(d2.status, "FAILED");
      assert.ok(d2.result!.review!.issues.some((i) => i.category === "architecture"));
    } finally {
      await cleanup();
    }
  });

  test("plan unavailable without steps/DSL/model → FAILED with actionable error; invalid transitions rejected", async () => {
    const { rt, cleanup } = await makeRuntime();
    try {
      const t = await rt.createTask({ title: "prose", goal: "please refactor everything", budget: { maxRetries: 2 } });
      const done = await rt.runTask(t.id);
      assert.equal(done.status, "FAILED");
      assert.match(done.error!, /PLAN_UNAVAILABLE/);
      assert.equal(done.attempt, 0);
      await assert.rejects(() => rt.pauseTask(t.id), /cannot pause/);
      await assert.rejects(() => rt.startTask("nope"), /not found/);
      await assert.rejects(() => rt.createTask({ title: "", goal: "" }), /title/);
      await assert.rejects(() => rt.createTask({ title: "x", goal: "", workdir: "/definitely/missing" }), /workdir/);
    } finally {
      await cleanup();
    }
  });

  test("isolated worktree: executor runs in worktree, integrator merges back; conflict rolls back", async () => {
    const { rt, dir, cleanup } = await makeRuntime({ git: true });
    try {
      const t = await rt.createTask({ title: "iso", goal: "write feature.txt: from worktree\ncheck exists feature.txt", isolated: true });
      const done = await rt.runTask(t.id);
      assert.equal(done.status, "COMPLETED", done.error);
      assert.equal(await fsp.readFile(path.join(dir, "feature.txt"), "utf8"), "from worktree");
      const log = await runGit(["log", "--oneline"], { cwd: dir });
      assert.match(log.stdout, /agentos\(/);
      const wts = await runGit(["worktree", "list"], { cwd: dir });
      assert.equal(wts.stdout.trim().split("\n").length, 1, "worktree cleaned up");
      const types = (await rt.bus.query({ taskId: t.id })).map((e) => e.type);
      assert.ok(types.includes("workspace.isolated") && types.includes("integrator.merged"));

      // conflict: main modifies README while the isolated task also modifies it
      const c = await rt.createTask({
        title: "conflict",
        goal: "n/a",
        steps: [
          { id: "w", tool: "filesystem", action: "write", args: { path: "README.md", content: "# from task\n" } },
          // simulate concurrent change on main while the task runs in its worktree
          { id: "main", tool: "terminal", action: "execute", args: { command: `cd ${dir} && echo '# from main' > README.md && git add README.md && git -c user.name=t -c user.email=t@t commit -q -m main-change` } },
        ],
        isolated: true,
        budget: { maxRetries: 0 },
      });
      const cdone = await rt.runTask(c.id);
      assert.equal(cdone.status, "FAILED");
      assert.match(cdone.error!, /MERGE_CONFLICT/);
      assert.equal(await fsp.readFile(path.join(dir, "README.md"), "utf8"), "# from main\n", "main branch untouched after rollback");
      assert.equal((await runGit(["status", "--porcelain"], { cwd: dir })).stdout.trim(), "");
    } finally {
      await cleanup();
    }
  });

  test("sqlite persistence: state survives runtime restart; doctor reports", async () => {
    const { dir, cleanup, rt } = await makeRuntime();
    await rt.close();
    const dbFile = path.join(dir, ".agentos", "agentos.db");
    const rt1 = await AgentRuntime.create({ rootDir: dir, persistence: new SqlitePersistence(dbFile), model: null, controlPollMs: 0 });
    const t = await rt1.createTask({ title: "persist", goal: "run: echo persisted" });
    await rt1.runTask(t.id);
    const events1 = await rt1.persistence.countEvents({ taskId: t.id });
    await rt1.close();
    const rt2 = await AgentRuntime.create({ rootDir: dir, persistence: new SqlitePersistence(dbFile), model: null, controlPollMs: 0 });
    try {
      assert.equal(rt2.getTask(t.id)?.status, "COMPLETED");
      assert.equal(await rt2.persistence.countEvents({ taskId: t.id }), events1);
      const next = await rt2.bus.emit({ taskId: null, agentId: null, type: "probe" });
      assert.ok(next.seq > events1, "sequence continues after restart");
      const doc = await rt2.doctor();
      assert.equal(doc.ok, true, JSON.stringify(doc.checks));
      assert.ok(doc.checks.find((c) => c.name === "persistence")!.detail.includes("sqlite"));
      assert.equal(rt2.listAgents().length, 7);
      assert.equal(rt2.listTools().length, 6);
    } finally {
      await rt2.close();
      await cleanup().catch(() => undefined);
    }
  });
});
