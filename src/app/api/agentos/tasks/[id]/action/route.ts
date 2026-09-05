import { getServerRuntime } from "@/agentos/server";
import { fail, json } from "../../../_util";

export const dynamic = "force-dynamic";

const ACTIONS = ["start", "pause", "resume", "cancel", "retry", "recover"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { action } = (await req.json()) as { action: Action };
    if (!ACTIONS.includes(action)) return json({ error: `unknown action ${action}` }, { status: 400 });
    const rt = await getServerRuntime();
    switch (action) {
      case "start":
        return json({ task: await rt.startTask(id) });
      case "pause": {
        // do not await the paused promise (it resolves when the current tool call yields); respond immediately
        const task = rt.getTask(id);
        if (task && ["QUEUED"].includes(task.status)) return json({ task: await rt.pauseTask(id) });
        void rt.pauseTask(id).catch(() => undefined);
        return json({ task: rt.getTask(id), pending: true });
      }
      case "resume":
        return json({ task: await rt.resumeTask(id) });
      case "cancel": {
        void rt.cancelTask(id).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 50));
        return json({ task: rt.getTask(id), pending: true });
      }
      case "retry":
        return json({ task: await rt.retryTask(id) });
      case "recover":
        return json(await rt.recoverTask(id));
    }
  } catch (err) {
    return fail(err);
  }
}
