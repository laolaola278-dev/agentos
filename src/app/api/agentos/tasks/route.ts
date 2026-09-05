import { getServerRuntime } from "@/agentos/server";
import type { TaskSpec, TaskStatus } from "@/agentos/types";
import { fail, json } from "../_util";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const rt = await getServerRuntime();
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const tasks = rt.listTasks(status ? (status.toUpperCase().split(",") as TaskStatus[]) : undefined);
    return json({ tasks: tasks.map((t) => ({ ...t, result: undefined })), running: rt.runningCount(), concurrency: rt.concurrency });
  } catch (err) {
    return fail(err, 500);
  }
}

export async function POST(req: Request) {
  try {
    const rt = await getServerRuntime();
    const body = (await req.json()) as TaskSpec & { start?: boolean };
    const { start, ...spec } = body;
    const task = await rt.createTask(spec);
    if (start !== false) await rt.startTask(task.id);
    return json({ task }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
