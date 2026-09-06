import { getApprovalBridge, getServerRuntime } from "@/agentos/server";
import { fail, json } from "@/app/api/agentos/_util";

export const dynamic = "force-dynamic";

/** List pending web approvals (polled by the dashboard approval toast). */
export async function GET() {
  try {
    const bridge = await getApprovalBridge();
    const now = Date.now();
    for (const [id, entry] of bridge.pending) {
      if (Date.parse(entry.approval.expiresAt) < now) {
        bridge.pending.delete(id);
        entry.resolve(false);
      }
    }
    return json({ pending: [...bridge.pending.values()].map((e) => e.approval) });
  } catch (err) {
    return fail(err, 500);
  }
}

/** Approve or deny a pending approval: { id, decision: "approve" | "deny" }. */
export async function POST(req: Request) {
  try {
    const { id, decision } = (await req.json()) as { id?: string; decision?: "approve" | "deny" };
    if (!id || (decision !== "approve" && decision !== "deny")) return json({ error: "expected { id, decision: approve|deny }" }, { status: 400 });
    const bridge = await getApprovalBridge();
    const entry = bridge.pending.get(id);
    if (!entry) return json({ error: `no pending approval ${id}` }, { status: 404 });
    const rt = await getServerRuntime();
    await rt.bus
      .emit({
        taskId: entry.approval.request.taskId,
        agentId: null,
        type: decision === "approve" ? "approval.granted" : "approval.denied",
        data: { approvalId: id, tool: entry.approval.request.tool, action: entry.approval.request.action },
      })
      .catch(() => undefined);
    entry.resolve(decision === "approve");
    return json({ id, decision, resolved: true });
  } catch (err) {
    return fail(err, 500);
  }
}
