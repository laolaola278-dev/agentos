import { getServerRuntime } from "@/agentos/server";
import { fail, json } from "../_util";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const rt = await getServerRuntime();
    const format = new URL(req.url).searchParams.get("format");
    if (format === "prometheus") return new Response(rt.metrics.toPrometheus(), { headers: { "content-type": "text/plain; version=0.0.4" } });
    const counts = rt.queue.countByStatus();
    return json({ ...rt.metrics.snapshot(), queue: counts, running: rt.runningCount(), bus: rt.bus.stats, persistedEvents: await rt.persistence.countEvents() });
  } catch (err) {
    return fail(err, 500);
  }
}
