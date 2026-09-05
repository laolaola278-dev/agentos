// Child process used by recovery tests: runs a slow multi-step task until killed.
import { AgentRuntime } from "@/agentos/runtime";

async function main() {
  const [dir, mode] = process.argv.slice(2);
  const rt = await AgentRuntime.create({ rootDir: dir, persistence: "sqlite", model: null, controlPollMs: 200, heartbeatMs: 200 });
  if (mode === "recover") {
    const r = await rt.recoverAll();
    console.log(JSON.stringify({ recovered: r.recovered }));
    await rt.waitForIdle();
    await rt.close();
    return;
  }
  const t = await rt.createTask({
    title: "crash-me",
    goal: "n/a",
    steps: [
      { id: "s1", tool: "terminal", action: "execute", args: { command: "echo s1 >> steps.log" } },
      { id: "s2", tool: "terminal", action: "execute", args: { command: "echo s2 >> steps.log; sleep 3" } },
      { id: "s3", tool: "terminal", action: "execute", args: { command: "echo s3 >> steps.log" } },
    ],
    verification: [{ name: "all-steps", kind: "custom", command: "grep -q s3 steps.log" }],
  });
  console.log(JSON.stringify({ taskId: t.id }));
  const done = await rt.runTask(t.id);
  console.log(JSON.stringify({ status: done.status }));
  await rt.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
