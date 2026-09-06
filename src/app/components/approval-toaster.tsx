"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface PendingApproval {
  id: string;
  request: { taskId: string; tool: string; action: string; args: Record<string, unknown> };
  createdAt: string;
  expiresAt: string;
}

/**
 * Web approval gate: polls pending confirm-mode tool calls and surfaces an
 * approve/deny toast. Deny (or a timeout) fails closed — the tool call is
 * rejected with PERMISSION_DENIED, matching the terminal `chat` semantics.
 */
export default function ApprovalToaster() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [decided, setDecided] = useState<{ id: string; ok: boolean } | null>(null);
  const timers = useRef(new Set<string>());

  const decide = useCallback(async (id: string, decision: "approve" | "deny") => {
    if (timers.current.has(id)) return;
    timers.current.add(id);
    try {
      const key = typeof window === "undefined" ? "" : window.localStorage.getItem("agentos-api-key") ?? "";
      const res = await fetch("/api/agentos/approvals", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ id, decision }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setDecided({ id, ok: decision === "approve" });
      setApprovals((list) => list.filter((a) => a.id !== id));
    } catch (err) {
      setDecided({ id, ok: false, ...({ error: err instanceof Error ? err.message : String(err) } as { error?: string }) } as { id: string; ok: boolean });
      setApprovals((list) => list.filter((a) => a.id !== id));
    } finally {
      timers.current.delete(id);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const key = typeof window === "undefined" ? "" : window.localStorage.getItem("agentos-api-key") ?? "";
        const res = await fetch("/api/agentos/approvals", { headers: key ? { authorization: `Bearer ${key}` } : {} });
        if (!res.ok) return;
        const body = (await res.json()) as { pending: PendingApproval[] };
        if (alive) setApprovals((prev) => {
          const known = new Set(prev.map((p) => p.id));
          return [...prev, ...body.pending.filter((p) => !known.has(p.id))];
        });
      } catch {
        // approval polling is best-effort
      }
    };
    const initial = window.setTimeout(() => void poll(), 0);
    const id = window.setInterval(() => void poll(), 1500);
    return () => {
      alive = false;
      window.clearTimeout(initial);
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!decided) return;
    const t = window.setTimeout(() => setDecided(null), 4000);
    return () => window.clearTimeout(t);
  }, [decided]);

  return (
    <>
      {decided && (
        <div className={`fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-lg ${decided.ok ? "bg-emerald-600" : "bg-rose-600"}`}>
          {decided.ok ? "已批准 — 工具调用继续" : "已拒绝 — 调用以 PERMISSION_DENIED 失败"}
        </div>
      )}
      {approvals.map((a) => (
        <div key={a.id} className="fixed bottom-5 right-5 z-50 w-96 rounded-2xl bg-white p-4 shadow-xl ring-1 ring-slate-300">
          <div className="text-sm font-semibold text-slate-900">需要批准的工具调用</div>
          <div className="mt-2 font-mono text-xs text-slate-700">
            {a.request.tool}.{a.request.action}
          </div>
          <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] leading-4 text-slate-600 ring-1 ring-slate-200">{JSON.stringify(a.request.args, null, 2)}</pre>
          <div className="mt-3 flex justify-end gap-2 text-sm">
            <button onClick={() => void decide(a.id, "deny")} className="rounded-lg bg-rose-600 px-3 py-1.5 font-semibold text-white hover:bg-rose-500">
              拒绝
            </button>
            <button onClick={() => void decide(a.id, "approve")} className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500">
              批准
            </button>
          </div>
          <div className="mt-2 text-right text-[10px] text-slate-400">超时自动拒绝（fail-closed）</div>
        </div>
      ))}
    </>
  );
}
