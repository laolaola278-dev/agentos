import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { createDefaultToolRegistry, ToolRegistry, runCommand, ProcessManager } from "@/agentos/tools";
import { HttpTool } from "@/agentos/tools/http";
import { runGit } from "@/agentos/tools/git";
import { VerificationEngine } from "@/agentos/verification";
import { EventBus } from "@/agentos/events";
import { MemoryPersistence } from "@/agentos/persistence";
import type { Tool } from "@/agentos/types";
import { tmpDir } from "../helpers";

async function setup() {
  const dir = await tmpDir();
  const { registry, processes } = createDefaultToolRegistry();
  const exec = (tool: string, action: string, args: Record<string, unknown>, extra: Partial<Parameters<ToolRegistry["execute"]>[2]> = {}) =>
    registry.execute(tool, { action, args }, { taskId: "t", agentId: "a", workdir: dir, ...extra });
  return { dir, registry, processes, exec };
}

/** Polls `terminal.poll` until `re` matches the accumulated stdout (or times out). */
async function waitForProcessOutput(
  exec: (tool: string, action: string, args: Record<string, unknown>) => Promise<{ data?: unknown; error?: { code: string } }>,
  id: string,
  re: RegExp,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const poll = await exec("terminal", "poll", { id });
    last = String((poll.data as { stdout?: string } | undefined)?.stdout ?? "");
    if (re.test(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${re} in process output; saw: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("filesystem tool", () => {
  test("write/read/append/edit/list/search/stat/move/copy/delete", async () => {
    const { exec, dir } = await setup();
    assert.equal((await exec("filesystem", "write", { path: "src/a.txt", content: "hello\nworld\n" })).ok, true);
    const read = await exec("filesystem", "read", { path: "src/a.txt" });
    assert.equal((read.data as { content: string }).content, "hello\nworld\n");
    await exec("filesystem", "append", { path: "src/a.txt", content: "more\n" });
    const edit = await exec("filesystem", "edit", { path: "src/a.txt", oldText: "world", newText: "there" });
    assert.equal(edit.ok, true);
    const amb = await exec("filesystem", "edit", { path: "src/a.txt", oldText: "\n", newText: "" });
    assert.equal(amb.error?.code, "EDIT_AMBIGUOUS");
    const nomatch = await exec("filesystem", "edit", { path: "src/a.txt", oldText: "zzz", newText: "" });
    assert.equal(nomatch.error?.code, "EDIT_NO_MATCH");
    const list = await exec("filesystem", "list", { path: ".", recursive: true });
    assert.ok((list.data as { entries: { path: string }[] }).entries.some((e) => e.path === path.join("src", "a.txt")));
    const search = await exec("filesystem", "search", { pattern: "th.re", glob: "*.txt" });
    assert.equal((search.data as { matches: unknown[] }).matches.length, 1);
    assert.equal(((await exec("filesystem", "stat", { path: "src/a.txt" })).data as { isFile: boolean }).isFile, true);
    await exec("filesystem", "move", { from: "src/a.txt", to: "b.txt" });
    await exec("filesystem", "copy", { from: "b.txt", to: "c.txt" });
    assert.equal(((await exec("filesystem", "exists", { path: "src/a.txt" })).data as { exists: boolean }).exists, false);
    assert.equal(((await exec("filesystem", "exists", { path: "c.txt" })).data as { exists: boolean }).exists, true);
    assert.equal((await exec("filesystem", "delete", { path: "src" })).error?.code, "IS_DIRECTORY");
    assert.equal((await exec("filesystem", "delete", { path: "src", recursive: true })).ok, true);
    assert.equal((await exec("filesystem", "delete", { path: "." })).error?.code, "REFUSED");
    await fsp.access(path.join(dir, "c.txt"));
  });
  test("errors: traversal, missing, permission, binary, large files, missing args", async () => {
    const { exec, dir } = await setup();
    assert.equal((await exec("filesystem", "read", { path: "../../etc/passwd" })).error?.code, "PATH_TRAVERSAL");
    assert.equal((await exec("filesystem", "read", { path: "nope.txt" })).error?.code, "NOT_FOUND");
    assert.equal((await exec("filesystem", "read", {})).error?.code, "MISSING_ARGUMENT");
    assert.equal((await exec("filesystem", "write", { path: "x", content: 5 })).error?.code, "INVALID_ARGUMENT");
    await fsp.writeFile(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 255]));
    const bin = await exec("filesystem", "read", { path: "bin.dat" });
    assert.equal((bin.data as { binary: boolean; content: null }).binary, true);
    assert.equal((bin.data as { content: null }).content, null);
    const b64 = await exec("filesystem", "read", { path: "bin.dat", encoding: "base64" });
    assert.equal((b64.data as { content: string }).content, Buffer.from([0, 1, 2, 3, 255]).toString("base64"));
    await fsp.writeFile(path.join(dir, "big.txt"), "x".repeat(3 * 1024 * 1024));
    const big = await exec("filesystem", "read", { path: "big.txt" });
    assert.equal((big.data as { truncated: boolean }).truncated, true);
    assert.ok((big.data as { content: string }).content.length <= 1024 * 1024 + 100);
    if (process.getuid && process.getuid() !== 0) {
      await fsp.writeFile(path.join(dir, "ro.txt"), "x");
      await fsp.chmod(path.join(dir, "ro.txt"), 0o000);
      assert.equal((await exec("filesystem", "read", { path: "ro.txt" })).error?.code, "PERMISSION_DENIED");
      await fsp.chmod(path.join(dir, "ro.txt"), 0o644);
    }
  });
  test("concurrent writes to the same file are atomic (no torn content)", async () => {
    const { exec, dir } = await setup();
    await Promise.all(Array.from({ length: 50 }, (_, i) => exec("filesystem", "write", { path: "c.txt", content: String(i).repeat(1000) })));
    const content = await fsp.readFile(path.join(dir, "c.txt"), "utf8");
    // the file must equal exactly one writer's full payload — never a mix of two writers
    const winner = content.slice(0, content.length / 1000);
    assert.ok(Array.from({ length: 50 }, (_, i) => String(i).repeat(1000)).includes(content), `torn write detected (starts with ${winner})`);
    const leftovers = (await fsp.readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.equal(leftovers.length, 0);
  });
});

describe("terminal + process tools", () => {
  test("captures stdout/stderr/exit code; non-zero exit; stdin closed for interactive programs", async () => {
    const { exec } = await setup();
    const ok = await exec("terminal", "execute", { command: "echo out; echo err 1>&2; exit 0" });
    assert.equal(ok.ok, true);
    assert.equal((ok.data as { stdout: string }).stdout.trim(), "out");
    assert.equal((ok.data as { stderr: string }).stderr.trim(), "err");
    const bad = await exec("terminal", "execute", { command: "exit 3" });
    assert.equal(bad.ok, true); // structured result — non-zero exit is data, not a crash
    assert.equal((bad.data as { exitCode: number }).exitCode, 3);
    const interactive = await exec("terminal", "execute", { command: "read -r x; echo got:$x", input: "abc\n" }, { timeoutMs: 5000 });
    assert.equal((interactive.data as { stdout: string }).stdout.trim(), "got:abc");
    const eof = await exec("terminal", "execute", { command: "cat; echo done" }, { timeoutMs: 5000 });
    assert.equal((eof.data as { stdout: string }).stdout.trim(), "done");
  });
  test("timeout kills the whole process tree; huge output is capped; crash is structured", async () => {
    const { exec } = await setup();
    const t0 = Date.now();
    const to = await exec("terminal", "execute", { command: "sleep 30 & sleep 30; echo never", timeoutMs: 300 });
    assert.equal(to.error?.code, "TIMEOUT");
    assert.ok(Date.now() - t0 < 5000);
    const huge = await exec("terminal", "execute", { command: "yes | head -c 5000000", maxOutputBytes: 10000 });
    assert.ok((huge.data as { truncated: boolean }).truncated);
    assert.ok((huge.data as { stdout: string }).stdout.length < 20000);
    const crash = await exec("terminal", "execute", { command: "kill -SEGV $$" });
    assert.equal((crash.data as { signal: string }).signal, "SIGSEGV");
    const dangerous = await exec("terminal", "execute", { command: "rm -rf /" });
    assert.equal(dangerous.error?.code, "DANGEROUS_COMMAND");
    const outside = await exec("terminal", "execute", { command: "pwd", cwd: "../" });
    assert.equal(outside.error?.code, "PATH_TRAVERSAL");
  });
  test("cancellation via abort signal", async () => {
    const { exec } = await setup();
    const ac = new AbortController();
    setTimeout(() => ac.abort("cancel"), 100);
    const r = await exec("terminal", "execute", { command: "sleep 20" }, { signal: ac.signal, timeoutMs: 10000 });
    assert.equal(r.ok, false);
    assert.ok(["ABORTED", "TOOL_ERROR"].includes(r.error!.code) || r.error!.message === "cancel");
  });
  test("background processes: start/poll/stop, list/kill/wait/output, limit", async () => {
    const { exec, processes } = await setup();
    const start = await exec("terminal", "start", { command: "for i in 1 2 3; do echo tick$i; sleep 0.1; done; sleep 30" });
    const id = (start.data as { id: string }).id;
    // Poll for the marker instead of sleeping a fixed 500ms: on Windows each
    // `sleep` is a separate fork/exec costing ~250-300ms, so a fixed wait is a
    // POSIX-calibrated guess that flakes here. The product streams output as it
    // arrives — only the test's timing assumption was wrong.
    const stdout = await waitForProcessOutput(exec, id, /tick3/, 15_000);
    assert.match(stdout, /tick3/);
    const poll = await exec("terminal", "poll", { id });
    assert.equal((poll.data as { running: boolean }).running, true);
    const list = await exec("process", "list", {});
    assert.equal((list.data as { processes: unknown[] }).processes.length, 1);
    const wait = await exec("process", "wait", { id, timeoutMs: 100 });
    assert.equal((wait.data as { finished: boolean }).finished, false);
    const kill = await exec("process", "kill", { id });
    assert.equal((kill.data as { running: boolean }).running, false);
    assert.equal((await exec("process", "output", { id: "nope" })).error?.code, "NOT_FOUND");
    const pm = new ProcessManager(1);
    pm.start("sleep 5", { cwd: "/tmp", taskId: "t" });
    assert.throws(() => pm.start("sleep 5", { cwd: "/tmp", taskId: "t" }), /limit/);
    await pm.shutdown();
    await processes.shutdown();
  });
  test("runCommand never rejects for runtime failures", async () => {
    const r = await runCommand("nonexistent-cmd-xyz", { cwd: "/tmp", timeoutMs: 2000 });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /not found/);
  });
});

describe("git tool", () => {
  test("init/status/add/commit/log/diff/branch/checkout/stash/merge conflict rollback", async () => {
    const { exec, dir } = await setup();
    await exec("git", "init", {});
    await runGit(["checkout", "-q", "-b", "main"], { cwd: dir });
    await fsp.writeFile(path.join(dir, "f.txt"), "one\n");
    let st = await exec("git", "status", {});
    assert.equal((st.data as { clean: boolean }).clean, false);
    await exec("git", "add", { paths: ["f.txt"] });
    const c1 = await exec("git", "commit", { message: "first" });
    assert.equal(c1.ok, true);
    assert.equal((await exec("git", "commit", { message: "again" })).error?.code, "NOTHING_TO_COMMIT");
    st = await exec("git", "status", {});
    assert.equal((st.data as { clean: boolean }).clean, true);
    const log = await exec("git", "log", { limit: 5 });
    assert.equal((log.data as { commits: { subject: string }[] }).commits[0].subject, "first");
    await fsp.writeFile(path.join(dir, "f.txt"), "two\n");
    const diff = await exec("git", "diff", {});
    assert.match((diff.data as { diff: string }).diff, /-one\n\+two/);
    const stash = await exec("git", "stash", { op: "push", message: "wip" });
    assert.equal(stash.ok, true);
    assert.equal(((await exec("git", "stash", { op: "list" })).data as { stashes: string[] }).stashes.length, 1);
    await exec("git", "stash", { op: "pop" });
    await exec("git", "add", { paths: ["f.txt"] });
    await exec("git", "commit", { message: "second" });
    // conflict scenario
    await exec("git", "checkout", { ref: "feature", create: true });
    await fsp.writeFile(path.join(dir, "f.txt"), "feature\n");
    await exec("git", "add", { paths: ["f.txt"] });
    await exec("git", "commit", { message: "feature" });
    await exec("git", "checkout", { ref: "main" });
    await fsp.writeFile(path.join(dir, "f.txt"), "main\n");
    await exec("git", "add", { paths: ["f.txt"] });
    await exec("git", "commit", { message: "main" });
    const merge = await exec("git", "merge", { branch: "feature" });
    assert.equal(merge.error?.code, "MERGE_CONFLICT");
    const after = await exec("git", "status", {});
    assert.equal((after.data as { clean: boolean }).clean, true, "merge must be aborted / rolled back");
    assert.equal(await fsp.readFile(path.join(dir, "f.txt"), "utf8"), "main\n");
    // injection guard
    assert.equal((await exec("git", "checkout", { ref: "--orphan" })).error?.code, "INVALID_ARGUMENT");
    // worktree
    const wt = await exec("git", "worktree_add", { path: "wt1", branch: "wt-branch" });
    assert.equal(wt.ok, true, JSON.stringify(wt.error));
    await fsp.writeFile(path.join(dir, "wt1", "new.txt"), "n\n");
    await runGit(["add", "-A"], { cwd: path.join(dir, "wt1") });
    await runGit(["commit", "-q", "-m", "wt"], { cwd: path.join(dir, "wt1") });
    const m2 = await exec("git", "merge", { branch: "wt-branch" });
    assert.equal(m2.ok, true, JSON.stringify(m2.error));
    await fsp.access(path.join(dir, "new.txt"));
    assert.equal((await exec("git", "worktree_remove", { path: "wt1", force: true })).ok, true);
  });
  test("state on non-repo and log on empty repo", async () => {
    const { exec } = await setup();
    assert.equal(((await exec("git", "state", {})).data as { isRepo: boolean }).isRepo, false);
    await exec("git", "init", {});
    assert.deepEqual(((await exec("git", "log", {})).data as { commits: unknown[] }).commits, []);
  });
});

describe("http tool", () => {
  test("mocked fetch: json parsing, size cap, blocked hosts, network errors, timeouts", async () => {
    const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("slow")) {
        await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      if (u.includes("fail")) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      if (u.includes("big")) return new Response("x".repeat(10_000), { headers: { "content-type": "text/plain" } });
      return new Response(JSON.stringify({ echo: init?.method, body: init?.body ?? null }), { headers: { "content-type": "application/json", "set-cookie": "session=abc" } });
    }) as typeof fetch;
    const reg = new ToolRegistry().register(new HttpTool({ fetchImpl }));
    const exec = (action: string, args: Record<string, unknown>) => reg.execute("http", { action, args }, { taskId: "t", agentId: "a", workdir: "/tmp", timeoutMs: 500 });
    const post = await exec("post", { url: "https://api.example.com/x", body: { a: 1 } });
    assert.equal((post.data as { json: { echo: string } }).json.echo, "POST");
    assert.equal((post.data as { headers: Record<string, string> }).headers["set-cookie"], "[REDACTED]");
    const big = await exec("get", { url: "https://api.example.com/big", maxBytes: 1000 });
    assert.equal((big.data as { truncated: boolean }).truncated, true);
    assert.equal((await exec("get", { url: "http://169.254.169.254/" })).error?.code, "BLOCKED_HOST");
    assert.equal((await exec("get", { url: "ftp://x" })).error?.code, "INVALID_URL");
    const fail = await exec("get", { url: "https://fail.example.com" });
    assert.equal(fail.error?.code, "NETWORK_ERROR");
    assert.equal(fail.error?.retryable, true);
    const slow = await exec("get", { url: "https://slow.example.com" });
    assert.equal(slow.error?.code, "TIMEOUT");
  });
});

describe("tool registry", () => {
  test("unknown tool/action, timeout, thrown non-Error, huge payload truncation, events", async () => {
    const store = new MemoryPersistence();
    const bus = new EventBus(store);
    const weird: Tool = {
      name: "weird",
      description: "misbehaving tool for tests",
      actions: [
        { name: "throwString", description: "", params: {} },
        { name: "hang", description: "", params: {} },
        { name: "huge", description: "", params: {} },
        { name: "circular", description: "", params: {} },
      ],
      async execute(input, ctx) {
        if (input.action === "throwString") throw "plain string failure";
        if (input.action === "hang") return new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("late")));
        if (input.action === "huge") return { blob: "x".repeat(2_000_000), list: Array.from({ length: 10_000 }, (_, i) => i) };
        const o: Record<string, unknown> = { a: 1 };
        o.self = o;
        return o;
      },
    };
    const reg = new ToolRegistry().register(weird);
    const exec = (tool: string, action: string, timeoutMs = 1000) => reg.execute(tool, { action, args: {} }, { taskId: "t", agentId: "a", workdir: "/tmp", timeoutMs, bus });
    assert.equal((await exec("nope", "x")).error?.code, "UNKNOWN_TOOL");
    assert.equal((await exec("weird", "nope")).error?.code, "UNKNOWN_ACTION");
    const thrown = await exec("weird", "throwString");
    assert.equal(thrown.ok, false);
    assert.match(thrown.error!.message, /plain string/);
    const hang = await exec("weird", "hang", 100);
    assert.equal(hang.error?.code, "TIMEOUT");
    assert.equal(hang.error?.retryable, true);
    const huge = await exec("weird", "huge");
    assert.equal(huge.truncated, true);
    assert.ok(JSON.stringify(huge.data).length < 400_000);
    const circ = await exec("weird", "circular");
    assert.equal(circ.ok, true); // truncatePayload walks with depth limit, never throws
    const events = await store.queryEvents({ typePrefix: "tool." });
    assert.equal(events.filter((e) => e.type === "tool.failed").length, 4);
    assert.equal(events.filter((e) => e.type === "tool.completed").length, 2);
    assert.throws(() => reg.register(weird), /already registered/);
  });
});

describe("verification engine", () => {
  test("runs commands, captures artifacts, handles timeouts and acceptance checks", async () => {
    const dir = await tmpDir();
    const engine = new VerificationEngine();
    const store = new MemoryPersistence();
    const bus = new EventBus(store);
    await fsp.writeFile(path.join(dir, "a.txt"), "content");
    const results = await engine.runAll(
      [
        { name: "pass", kind: "custom", command: "echo ok" },
        { name: "fail", kind: "custom", command: "echo bad 1>&2; exit 2" },
        { name: "slow", kind: "custom", command: "sleep 5", timeoutMs: 200 },
      ],
      { workdir: dir, artifactsDir: path.join(dir, "artifacts"), bus, taskId: "t" },
    );
    assert.deepEqual(results.map((r) => r.passed), [true, false, false]);
    assert.equal(results[1].exitCode, 2);
    assert.match(results[1].stderr, /bad/);
    assert.equal(results[2].timedOut, true);
    assert.equal(results[0].artifacts.length, 1);
    await fsp.access(results[0].artifacts[0]);
    const events = await store.queryEvents({ typePrefix: "test." });
    assert.equal(events.filter((e) => e.type === "test.passed").length, 1);
    assert.equal(events.filter((e) => e.type === "test.failed").length, 2);
    const acc = await engine.runAcceptance(
      [
        { type: "file_exists", path: "a.txt" },
        { type: "file_contains", path: "a.txt", text: "content" },
        { type: "file_not_contains", path: "a.txt", text: "content" },
        { type: "command_succeeds", command: "test -f a.txt" },
        { type: "file_exists", path: "../escape" },
      ],
      { workdir: dir },
    );
    assert.deepEqual(acc.map((a) => a.passed), [true, true, false, true, false]);
  });
});
