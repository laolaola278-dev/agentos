import { getServerRuntime } from "@/agentos/server";
import { fail, json } from "../_util";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const rt = await getServerRuntime();
    const p = new URL(req.url).searchParams;
    const events = await rt.bus.query({
      taskId: p.get("taskId") ?? undefined,
      agentId: p.get("agentId") ?? undefined,
      type: p.get("type") ?? undefined,
      typePrefix: p.get("typePrefix") ?? undefined,
      afterId: p.get("afterId") ? Number(p.get("afterId")) : undefined,
      limit: p.get("limit") ? Number(p.get("limit")) : 200,
    });
    return json({ events });
  } catch (err) {
    return fail(err, 500);
  }
}
