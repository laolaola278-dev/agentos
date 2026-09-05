"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AgentEvent, Checkpoint, Task } from "@/agentos/types";
import { StatusBadge, fmtMs, taskAction } from "./dashboard";

const ROLE_FOR_STATUS: Record<string, string> = { PLANNING: "planner", EXECUTING: "executor", VERIFYING: "tester", FIXING: "debugger → executor", REVIEWING: "reviewer", DIAGNOSING: "debugger", RETRYING: "planner" };

const EVENT_COLORS: Record<string, string> = {
  "task.": "text-slate-900",
  "agent.": "text-indigo-700",
  "tool.": "text-blue-700",
  "test.": "text-amber-700",
  "review.": "text-purple-700",
  "checkpoint.": "text-slate-400",
  "integrator.": "text-emerald-700",
  "workspace.": "text-emerald-700",
  "model.": "text-pink-700",
};

function eventColor(type: string) {
  for (const [prefix, cls] of Object.entries(EVENT_COLORS)) if (type.startsWith(prefix)) return cls;
  return "text-slate-700";
}

export default function TaskDetail({ id }: { id: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  const [tab, setTab] = useState<"timeline" | "plan" | "verification" | "review" | "logs">("timeline");
  const lastId = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  const loadTask = useCallback(async () => {
    const res = await fetch(`/api/agentos/tasks/${id}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    setTask(body.task);
    setCheckpoint(body.checkpoint);
  }, [id]);

  useEffect(() => {
    const initial = setTimeout(() => loadTask().catch((e) => setError(e.message)), 0);
    const es = new EventSource(`/api/agentos/events/stream?taskId=${encodeURIComponent(id)}`);
    es.addEventListener("event", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as AgentEvent;
      if ((e.id ?? 0) <= lastId.current) return;
      lastId.current = e.id ?? lastId.current;
      setEvents((prev) => [...prev.slice(-2000), e]);
      if (e.type.startsWith("task.") || e.type === "review.completed") loadTask().catch(() => undefined);
    });
    es.addEventListener("task", (m) => {
      const t = JSON.parse((m as MessageEvent).data) as Task;
      setTask((prev) => (prev ? { ...prev, ...t, result: prev.result } : t));
    });
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => {
      clearTimeout(initial);
      es.close();
    };
  }, [id, loadTask]);

  useEffect(() => {
    if (tab === "timeline") bottom.current?.scrollIntoView({ block: "nearest" });
  }, [events, tab]);

  const act = async (action: string) => {
    try {
      await taskAction(id, action);
      setTimeout(() => loadTask().catch(() => undefined), 300);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error && !task) return <div className="p-8 text-rose-700">{error}</div>;
  if (!task) return <div className="p-8 text-slate-500">Loading…</div>;

  const visibleEvents = events.filter((e) => showCheckpoints || !e.type.startsWith("checkpoint."));
  const progress = checkpoint?.progress ?? (task.status === "COMPLETED" ? 100 : 0);
  const toolCalls = events.filter((e) => e.type === "tool.completed" || e.type === "tool.failed");
  const tests = events.filter((e) => e.type === "test.passed" || e.type === "test.failed");
  const errors = events.filter((e) => e.error);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href="/" className="text-sm text-slate-500 hover:underline">
            ← Dashboard
          </Link>
          <h1 className="mt-1 flex items-center gap-3 text-2xl font-bold text-slate-900">
            <StatusBadge status={task.status} /> <span className="truncate">{task.spec.title}</span>
          </h1>
          <div className="text-xs text-slate-500">
            {task.id} · workdir {task.workdir} · attempt {task.attempt}/{task.budget.maxRetries} · created {new Date(task.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className={`text-xs ${live ? "text-emerald-600" : "text-slate-400"}`}>{live ? "● live" : "○ reconnecting"}</span>
          {["CREATED"].includes(task.status) && <button onClick={() => act("start")} className="rounded-md bg-emerald-600 px-3 py-1.5 text-white">Start</button>}
          {task.status === "PAUSED" && <button onClick={() => act("resume")} className="rounded-md bg-emerald-600 px-3 py-1.5 text-white">Resume</button>}
          {["QUEUED", "PLANNING", "EXECUTING", "VERIFYING", "FIXING", "REVIEWING"].includes(task.status) && <button onClick={() => act("pause")} className="rounded-md bg-yellow-500 px-3 py-1.5 text-white">Pause</button>}
          {!["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"].includes(task.status) && <button onClick={() => act("cancel")} className="rounded-md bg-rose-600 px-3 py-1.5 text-white">Cancel</button>}
          {["FAILED", "CANCELLED", "BLOCKED"].includes(task.status) && <button onClick={() => act("retry")} className="rounded-md bg-slate-700 px-3 py-1.5 text-white">Retry</button>}
        </div>
      </div>

      {error && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">{error}</div>}
      {task.error && <div className="rounded-xl bg-rose-50 p-3 font-mono text-xs text-rose-800 ring-1 ring-rose-200">{task.error}</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Card label="Progress" value={`${progress}%`}>
          <div className="mt-2 h-2 w-full rounded-full bg-slate-100">
            <div className="h-2 rounded-full bg-indigo-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
        </Card>
        <Card label="Active agent" value={ROLE_FOR_STATUS[task.status] ?? "—"} />
        <Card label="Tool calls" value={`${task.usage.toolCalls}/${task.budget.maxToolCalls}`} sub={`${toolCalls.filter((e) => e.type === "tool.failed").length} failed`} />
        <Card label="Tests" value={`${tests.filter((e) => e.type === "test.passed").length}/${tests.length}`} sub="passed" />
        <Card label="Retries / fixes" value={`${task.usage.retries} / ${task.usage.fixes}`} />
        <Card label="Elapsed" value={fmtMs(task.usage.elapsedMs)} sub={`budget ${fmtMs(task.budget.timeoutMs)} · tokens ${task.usage.tokens}`} />
      </div>

      <div className="flex gap-2 border-b border-slate-200 text-sm">
        {(["timeline", "plan", "verification", "review", "logs"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 capitalize ${tab === t ? "border-b-2 border-slate-900 font-semibold" : "text-slate-500"}`}>
            {t}
            {t === "logs" && errors.length ? ` (${errors.length} errors)` : ""}
          </button>
        ))}
        {tab === "timeline" && (
          <label className="ml-auto flex items-center gap-1 text-xs text-slate-500">
            <input type="checkbox" checked={showCheckpoints} onChange={(e) => setShowCheckpoints(e.target.checked)} /> show checkpoints
          </label>
        )}
      </div>

      {tab === "timeline" && (
        <div className="max-h-[60vh] overflow-auto rounded-2xl bg-white p-4 font-mono text-xs shadow-sm ring-1 ring-slate-200">
          {visibleEvents.length === 0 && <div className="text-slate-500">No events yet.</div>}
          {visibleEvents.map((e) => (
            <div key={e.id ?? e.seq} className="flex gap-3 border-b border-slate-50 py-1">
              <span className="w-20 shrink-0 text-slate-400">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="w-24 shrink-0 truncate text-slate-500">{e.agentId ?? "runtime"}</span>
              <span className={`w-40 shrink-0 font-semibold ${eventColor(e.type)}`}>{e.type}</span>
              <span className="min-w-0 flex-1 truncate text-slate-700">
                {e.tool ? `${e.tool} ` : ""}
                {e.durationMs != null ? `${e.durationMs}ms ` : ""}
                {e.error ? <span className="text-rose-700">{e.error}</span> : e.data ? JSON.stringify(e.data).slice(0, 200) : e.args ? JSON.stringify(e.args).slice(0, 200) : ""}
              </span>
            </div>
          ))}
          <div ref={bottom} />
        </div>
      )}

      {tab === "plan" && (
        <div className="rounded-2xl bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200">
          {!(task.result?.plan ?? checkpoint?.plan) && <p className="text-slate-500">No plan yet.</p>}
          {(task.result?.plan ?? checkpoint?.plan) && (
            <>
              <p className="text-xs text-slate-500">
                source: {(task.result?.plan ?? checkpoint?.plan)!.source} — {(task.result?.plan ?? checkpoint?.plan)!.rationale}
              </p>
              <ol className="mt-2 space-y-1">
                {(task.result?.plan ?? checkpoint?.plan)!.steps.map((s) => {
                  const r = (task.result?.stepResults ?? checkpoint?.completedSteps ?? []).filter((x) => x.stepId === s.id).at(-1);
                  return (
                    <li key={s.id} className="flex gap-2 rounded-lg bg-slate-50 p-2">
                      <span className={`w-16 shrink-0 text-xs font-semibold ${r ? (r.ok ? "text-emerald-700" : "text-rose-700") : "text-slate-400"}`}>{r ? (r.ok ? "done" : "failed") : "pending"}</span>
                      <span className="font-mono text-xs">
                        <b>{s.id}</b> {s.tool}.{s.action} {JSON.stringify(s.args).slice(0, 300)}
                        {r?.error && <div className="text-rose-700">{r.error}</div>}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      )}

      {tab === "verification" && (
        <div className="space-y-3">
          {(task.result?.verification ?? checkpoint?.verification ?? []).length === 0 && <p className="text-sm text-slate-500">No verification results.</p>}
          {(task.result?.verification ?? checkpoint?.verification ?? []).map((v, i) => (
            <div key={i} className="rounded-2xl bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${v.passed ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>{v.passed ? "PASS" : "FAIL"}</span>
                <b>{v.name}</b> <span className="text-xs text-slate-500">{v.kind} · exit {v.exitCode ?? "—"} · {fmtMs(v.durationMs)}{v.timedOut ? " · timeout" : ""}</span>
              </div>
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">$ {v.command}
{v.stdout}{v.stderr && `\n[stderr]\n${v.stderr}`}</pre>
            </div>
          ))}
        </div>
      )}

      {tab === "review" && (
        <div className="rounded-2xl bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200">
          {!(task.result?.review ?? checkpoint?.review) && <p className="text-slate-500">Not reviewed yet.</p>}
          {(task.result?.review ?? checkpoint?.review) && (
            <>
              <div className="text-lg font-semibold">Verdict: {(task.result?.review ?? checkpoint?.review)!.verdict}</div>
              <ul className="mt-2 list-disc pl-5 text-xs text-slate-600">
                {(task.result?.review ?? checkpoint?.review)!.checked.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <div className="mt-3 space-y-1">
                {(task.result?.review ?? checkpoint?.review)!.issues.map((i, idx) => (
                  <div key={idx} className={`rounded-lg p-2 text-xs ${i.severity === "high" ? "bg-rose-50 text-rose-800" : i.severity === "medium" ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-700"}`}>
                    <b>{i.severity}</b> · {i.category} · {i.message} {i.fixable ? "(fixable)" : ""}
                  </div>
                ))}
              </div>
            </>
          )}
          {(task.result?.diagnosis ?? checkpoint?.diagnosis) && (
            <div className="mt-4 rounded-lg bg-orange-50 p-3 text-xs text-orange-900">
              <b>Diagnosis ({(task.result?.diagnosis ?? checkpoint?.diagnosis)!.category})</b>: {(task.result?.diagnosis ?? checkpoint?.diagnosis)!.rootCause}
              <div className="mt-1">Next: {(task.result?.diagnosis ?? checkpoint?.diagnosis)!.recommendedNextAction}</div>
            </div>
          )}
        </div>
      )}

      {tab === "logs" && (
        <div className="max-h-[60vh] overflow-auto rounded-2xl bg-slate-900 p-4 font-mono text-xs text-slate-100">
          {errors.length === 0 && <div className="text-slate-400">No errors recorded.</div>}
          {errors.map((e) => (
            <div key={e.id ?? e.seq} className="border-b border-slate-800 py-1">
              <span className="text-slate-400">{new Date(e.ts).toLocaleTimeString()}</span> <span className="text-amber-300">{e.type}</span> {e.tool ?? ""} <span className="text-rose-300">{e.error}</span>
              {e.data && <div className="text-slate-400">{JSON.stringify(e.data).slice(0, 500)}</div>}
            </div>
          ))}
          {checkpoint && (
            <div className="mt-4 text-slate-400">
              checkpoint v{checkpoint.version} · phase {checkpoint.phase} · saved {checkpoint.savedAt} · {checkpoint.completedSteps.length} step results · {checkpoint.messages.length} messages
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Card({ label, value, sub, children }: { label: string; value: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold text-slate-900">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
      {children}
    </div>
  );
}
