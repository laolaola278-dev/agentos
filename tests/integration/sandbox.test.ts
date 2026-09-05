import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { dockerDaemonAvailable, type SandboxConfig } from "@/agentos/sandbox";
import { runCommand } from "@/agentos/tools/terminal";
import { makeRuntime } from "../helpers";

/**
 * Real container-sandbox tier: gated on a reachable Docker daemon (the CI/dev box
 * may not run one). Proves the command actually executed inside a Linux container
 * (`uname -s` → Linux on a Windows/POSIX host) and that the workspace is mounted.
 */
test("container sandbox runs terminal commands inside a Linux container", async (t) => {
  if (!(await dockerDaemonAvailable())) return t.skip("docker daemon not reachable");
  const pull = await runCommand("docker pull alpine:3", { cwd: process.cwd(), timeoutMs: 300_000 });
  assert.equal(pull.exitCode, 0, `pre-pulling alpine:3 failed: ${pull.stderr.slice(0, 300)}`);

  const sandbox: SandboxConfig = { mode: "container", image: "alpine:3", memoryMb: 256, network: false };
  const { rt, dir, cleanup } = await makeRuntime({ sandbox });
  try {
    const task = await rt.createTask({
      title: "sandboxed echo",
      goal: "n/a",
      steps: [
        { id: "s1", tool: "terminal", action: "execute", args: { command: "uname -s > inside.txt" } },
        { id: "s2", tool: "terminal", action: "execute", args: { command: "ls /workspace > listing.txt" } },
      ],
      acceptance: [{ type: "file_contains", path: "inside.txt", text: "Linux" }],
    });
    await rt.startTask(task.id);
    const done = await rt.waitForTask(task.id);
    assert.equal(done.status, "COMPLETED", `task ${done.status}: ${done.error}`);

    // the kernel the command saw is the container's, not the host's
    assert.match(await fsp.readFile(`${dir}/inside.txt`, "utf8"), /Linux/);
    // the workspace is mounted (host files visible inside, container files visible outside)
    const listing = await fsp.readFile(`${dir}/listing.txt`, "utf8");
    assert.match(listing, /inside\.txt/, "mount shows files created by earlier steps");

    // events show the docker-wrapped command, and no leftover run scripts
    const events = await rt.bus.query({ taskId: task.id, typePrefix: "tool." });
    assert.ok(events.some((e) => String((e.args as { args?: { command?: string } } | undefined)?.args?.command ?? "").includes("docker run --rm")), "executed command was docker-wrapped");
    const sandboxDir = `${dir}/.agentos-sandbox`;
    const leftovers = await fsp.readdir(sandboxDir).then((f) => f.length, () => 0);
    assert.equal(leftovers, 0, "run scripts cleaned up");
  } finally {
    await cleanup();
  }
});
