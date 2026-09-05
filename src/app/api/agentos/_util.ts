import { redactSecrets } from "@/agentos/security";

export const dynamic = "force-dynamic";

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(redactSecrets(data), init);
}

export function fail(err: unknown, status = 400) {
  const e = err as { code?: string; message?: string };
  return Response.json({ error: e?.message ?? String(err), code: e?.code ?? "ERROR" }, { status: e?.code === "TASK_NOT_FOUND" ? 404 : status });
}
