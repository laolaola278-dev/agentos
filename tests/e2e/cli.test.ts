import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpDir, rmRetry } from "../helpers";

const BIN = path.join(process.cwd(), "bin", "agentos.js");

function agentos(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("CLI end-to-end", () => {
  test("help, init, create/run/status/logs/result, pause via control file, recover, doctor, tools, agents, metrics", async () => {
    const dir = await tmpDir("agentos-cli-");
    try {
      const help = await agentos(["--help"], dir);
      assert.equal(help.code, 0);
      assert.match(help.stdout, /task run/);
      const init = await agentos(["init"], dir);
      assert.equal(init.code, 0, init.stderr);
      assert.match(init.stdout, /Initialised/);

      const create = await agentos(["task", "create", "--title", "cli-task", "--goal", "write hi.txt: hello\\nverify: grep -q hello hi.txt", "--json"], dir);
      assert.equal(create.code, 0, create.stderr);
      const created = JSON.parse(create.stdout) as { id: string; status: string };
      assert.equal(created.status, "CREATED");

      const run = await agentos(["task", "run", created.id], dir);
      assert.equal(run.code, 0, run.stderr + run.stdout);
      assert.match(run.stdout, /COMPLETED/);
      assert.equal(await fsp.readFile(path.join(dir, "hi.txt"), "utf8"), "hello");

      const status = await agentos(["task", "status", created.id, "--json"], dir);
      assert.equal((JSON.parse(status.stdout) as { status: string }).status, "COMPLETED");
      const list = await agentos(["task", "status"], dir);
      assert.match(list.stdout, /cli-task/);

      const logs = await agentos(["task", "logs", created.id, "--type", "test."], dir);
      assert.match(logs.stdout, /test\.passed/);
      const result = await agentos(["task", "result", created.id], dir);
      assert.match(JSON.parse(result.stdout).review.verdict, /PASS/);

      const failing = await agentos(["task", "run", "--goal", "n/a", "--step", 'terminal.execute:{"command":"exit 7"}', "--max-retries", "0"], dir);
      assert.equal(failing.code, 1);
      assert.match(failing.stdout, /FAILED/);

      // stale flag: spec file + verify flags
      await fsp.writeFile(path.join(dir, "spec.json"), JSON.stringify({ title: "from-spec", goal: "run: echo spec > spec.txt", verification: [{ name: "v", kind: "custom", command: "test -f spec.txt" }] }));
      const spec = await agentos(["task", "run", "--spec", "spec.json", "--quiet"], dir);
      assert.equal(spec.code, 0, spec.stdout + spec.stderr);

      const tools = await agentos(["tools", "list", "--json"], dir);
      assert.equal((JSON.parse(tools.stdout) as unknown[]).length, 5);
      const agents = await agentos(["agent", "list"], dir);
      assert.match(agents.stdout, /reviewer/);
      const metrics = await agentos(["metrics", "--prometheus"], dir);
      assert.match(metrics.stdout, /agentos_tasks_total/);
      const doctor = await agentos(["doctor"], dir);
      assert.equal(doctor.code, 0, doctor.stdout);
      const events = await agentos(["events", "--limit", "5", "--json"], dir);
      assert.equal((JSON.parse(events.stdout) as unknown[]).length, 5);
      const bad = await agentos(["bogus"], dir);
      assert.equal(bad.code, 2);
      const recover = await agentos(["recover"], dir);
      assert.match(recover.stdout, /nothing to recover/);
    } finally {
      await rmRetry(dir);
    }
  });

  test("pause from a second process, then resume from checkpoint", async () => {
    const dir = await tmpDir("agentos-cli2-");
    try {
      const create = await agentos(["task", "create", "--goal", "n/a", "--step", 'terminal.execute:{"command":"echo 1 >> t.log"}', "--step", 'terminal.execute:{"command":"echo 2 >> t.log; sleep 4"}', "--step", 'terminal.execute:{"command":"echo 3 >> t.log"}', "--json"], dir);
      const id = (JSON.parse(create.stdout) as { id: string }).id;
      const running = agentos(["task", "run", id, "--quiet"], dir);
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        const log = await fsp.readFile(path.join(dir, "t.log"), "utf8").catch(() => "");
        if (log.includes("2")) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const pause = await agentos(["task", "pause", id], dir);
      assert.match(pause.stdout, /control channel|paused/);
      const first = await running;
      assert.match(first.stdout, /PAUSED/);
      const resume = await agentos(["task", "resume", id], dir);
      assert.equal(resume.code, 0, resume.stdout + resume.stderr);
      const log = (await fsp.readFile(path.join(dir, "t.log"), "utf8")).trim().split("\n");
      assert.equal(log.filter((l) => l === "1").length, 1);
      assert.equal(log.at(-1), "3");
    } finally {
      await rmRetry(dir);
    }
  });
});
