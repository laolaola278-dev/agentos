import { getServerRuntime } from "@/agentos/server";
import { fail, json } from "../../_util";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rt = await getServerRuntime();
    const task = await rt.loadTask(id);
    if (!task) return json({ error: "task not found" }, { status: 404 });
    const checkpoint = await rt.persistence.loadCheckpoint(id);
    const eventCount = await rt.persistence.countEvents({ taskId: id });
    return json({ task, checkpoint, eventCount });
  } catch (err) {
    return fail(err, 500);
  }
}
