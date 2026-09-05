import { redactSecrets } from "@/agentos/security";

export const dynamic = "force-dynamic";

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(redactSecrets(data), init);
}

export function fail(err: unknown, status = 400) {
  const e = err as { code?: string; message?: string };
  return Response.json({ error: e?.message ?? String(err), code: e?.code ?? "ERROR" }, { status: e?.code === "TASK_NOT_FOUND" ? 404 : status });
}

/**
 * Scoped API-key enforcement for the dashboard API. Auth is OFF until an
 * `.agentos/apikeys.json` exists (`agentos apikeys create` creates it); when on,
 * every mutating route requires `Authorization: Bearer <key>` with a matching scope.
 */
export async function authorizeApiRequest(req: Request, scope: "tasks:read" | "tasks:write" | "admin"): Promise<Response | null> {
  const { getServerRuntime } = await import("@/agentos/server");
  const rt = await getServerRuntime();
  if (!rt.auth) return null; // auth disabled
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const decision = await rt.auth.authorize(bearer, scope);
  if (decision.allowed) return null;
  return Response.json({ error: decision.reason, status: decision.status }, { status: decision.status });
}
