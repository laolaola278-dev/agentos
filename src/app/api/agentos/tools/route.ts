import { getServerRuntime } from "@/agentos/server";
import { fail, json } from "../_util";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rt = await getServerRuntime();
    return json({ tools: rt.listTools(), metrics: rt.metrics.snapshot().tools });
  } catch (err) {
    return fail(err, 500);
  }
}
