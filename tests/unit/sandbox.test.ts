import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeSandboxConfig, planSandboxedCommand, resetDaemonProbe, dockerDaemonAvailable } from "@/agentos/sandbox";
import { tmpDir } from "../helpers";

test("normalizeSandboxConfig: defaults, string modes, validation", () => {
  assert.equal(normalizeSandboxConfig(undefined).mode, "none");
  assert.equal(normalizeSandboxConfig("container").mode, "container");
  const cfg = normalizeSandboxConfig({ mode: "container", memoryMb: 1024, network: true });
  assert.equal(cfg.memoryMb, 1024);
  assert.equal(cfg.network, true);
  assert.throws(() => normalizeSandboxConfig("jail"), /none\|process\|container/);
  assert.throws(() => normalizeSandboxConfig({ mode: "none", memoryMb: 1 }), /memoryMb/);
  assert.throws(() => normalizeSandboxConfig({ mode: "container", image: "img; rm -rf" }), /image/);
});

test("planSandboxedCommand none: passthrough, no cleanup needed", async () => {
  const plan = await planSandboxedCommand("echo hi", { workdir: ".", cfg: { mode: "none" } });
  assert.equal(plan.command, "echo hi");
  assert.equal(plan.mode, "none");
  await plan.cleanup();
});

test("planSandboxedCommand process: ulimit caps on POSIX, degrade note on win32", async () => {
  const plan = await planSandboxedCommand("echo hi", { workdir: ".", cfg: { mode: "process", memoryMb: 256, pidsLimit: 64 } });
  if (process.platform === "win32") {
    assert.equal(plan.mode, "none");
    assert.match(plan.note ?? "", /win32/);
  } else {
    assert.equal(plan.mode, "process");
    assert.match(plan.command, /^ulimit -v 262144/);
    assert.match(plan.command, /ulimit -u 64/);
    assert.ok(plan.command.endsWith("echo hi"));
  }
});

test("planSandboxedCommand container: writes run script, builds docker command, cleanup removes it", async () => {
  const dir = await tmpDir("agentos-sandbox-");
  try {
    const plan = await planSandboxedCommand("uname -s && ls", {
      workdir: dir,
      cfg: { mode: "container", image: "alpine:3", memoryMb: 512 },
      available: async () => true,
    });
    assert.equal(plan.mode, "container");
    assert.match(plan.command, /^MSYS_NO_PATHCONV=1/);
    assert.match(plan.command, /docker run --rm/);
    assert.match(plan.command, /--network none/);
    assert.match(plan.command, /--memory 512m/);
    assert.match(plan.command, /--cap-drop ALL/);
    assert.match(plan.command, /alpine:3/);
    assert.match(plan.command, /bash \/workspace\/\.agentos-sandbox\/run-[a-f0-9]+\.sh/);
    const scriptName = plan.command.match(/run-([a-f0-9]+)\.sh/)![1];
    const script = await fsp.readFile(path.join(dir, ".agentos-sandbox", `run-${scriptName}.sh`), "utf8");
    assert.match(script, /cd \/workspace/);
    assert.match(script, /uname -s && ls/);
    await plan.cleanup();
    await assert.rejects(fsp.readFile(path.join(dir, ".agentos-sandbox", `run-${scriptName}.sh`), "utf8"));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("planSandboxedCommand container: fails closed by default, degrades on demand", async () => {
  const offline = async () => false;
  await assert.rejects(
    planSandboxedCommand("echo hi", { workdir: ".", cfg: { mode: "container" }, available: offline }),
    (err: Error & { code?: string }) => err.code === "SANDBOX_UNAVAILABLE",
  );
  const degraded = await planSandboxedCommand("echo hi", { workdir: ".", cfg: { mode: "container", onUnavailable: "degrade" }, available: offline });
  assert.equal(degraded.mode, "none");
  assert.match(degraded.note ?? "", /degrade/);
});

test("dockerDaemonAvailable caches the probe result", async () => {
  resetDaemonProbe();
  let calls = 0;
  const probe = async () => {
    calls++;
    return true;
  };
  assert.equal(await dockerDaemonAvailable(probe), true);
  assert.equal(await dockerDaemonAvailable(probe), true);
  assert.equal(calls, 1, "probe ran once");
  resetDaemonProbe();
});
