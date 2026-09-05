import { getServerRuntime } from "@/agentos/server";
import { fail, json } from "../_util";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rt = await getServerRuntime();
    const running = rt.listTasks(["PLANNING", "EXECUTING", "VERIFYING", "FIXING", "REVIEWING", "DIAGNOSING", "RETRYING"]);
    const activeRoles: Record<string, string[]> = {};
    for (const t of running) {
      const role = { PLANNING: "planner", EXECUTING: "executor", VERIFYING: "tester", FIXING: "debugger", REVIEWING: "reviewer", DIAGNOSING: "debugger", RETRYING: "planner" }[t.status as string] ?? "unknown";
      (activeRoles[role] ??= []).push(t.id);
    }
    return json({ agents: rt.listAgents().map((a) => ({ ...a, activeTasks: activeRoles[a.role] ?? [] })), metrics: rt.metrics.snapshot().agents });
  } catch (err) {
    return fail(err, 500);
  }
}
