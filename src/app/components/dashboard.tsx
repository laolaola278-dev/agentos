"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ApprovalToaster from "./approval-toaster";
import type { Task, TaskStatus } from "@/agentos/types";
import type { MetricsSnapshot } from "@/agentos/metrics";

type TaskLite = Omit<Task, "result">;
type Metrics = MetricsSnapshot & { queue: Partial<Record<TaskStatus, number>>; running: number; bus: { seq: number; pending: number; droppedEvents: number; persistErrors: number }; persistedEvents: number };

export const STATUS_COLORS: Record<string, string> = {
  CREATED: "bg-slate-200 text-slate-800",
  QUEUED: "bg-slate-300 text-slate-900",
  PLANNING: "bg-indigo-100 text-indigo-800",
  EXECUTING: "bg-blue-100 text-blue-800",
  VERIFYING: "bg-amber-100 text-amber-800",
  FIXING: "bg-orange-100 text-orange-800",
  REVIEWING: "bg-purple-100 text-purple-800",
  DIAGNOSING: "bg-orange-200 text-orange-900",
  RETRYING: "bg-orange-100 text-orange-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-rose-100 text-rose-800",
  PAUSED: "bg-yellow-100 text-yellow-800",
  CANCELLED: "bg-slate-200 text-slate-600",
  BLOCKED: "bg-rose-50 text-rose-700",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[status] ?? "bg-slate-100"}`}>{status}</span>;
}

export function fmtMs(ms: number | undefined | null) {
  if (!ms && ms !== 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Attach the scoped API key (when the user stored one) to every dashboard call. */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const key = typeof window === "undefined" ? "" : window.localStorage.getItem("agentos-api-key") ?? "";
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (key) headers.set("authorization", `Bearer ${key}`);
  return fetch(input, { ...init, headers });
}

export async function taskAction(id: string, action: string) {
  const res = await apiFetch(`/api/agentos/tasks/${id}/action`, { method: "POST", body: JSON.stringify({ action }) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

const EXAMPLE_GOAL = `# One instruction per line (deterministic planner).
write hello/greeting.txt: Hello from AgentOS
run: cat hello/greeting.txt
verify: grep -q AgentOS hello/greeting.txt
check contains hello/greeting.txt: Hello`;

export default function Dashboard() {
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [form, setForm] = useState({ title: "", goal: EXAMPLE_GOAL, priority: 0, maxRetries: 2, isolated: false, workdir: "" });
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [t, m] = await Promise.all([apiFetch("/api/agentos/tasks").then((r) => r.json()), apiFetch("/api/agentos/metrics").then((r) => r.json())]);
      if (t.error) throw new Error(t.error);
      setTasks(t.tasks);
      setMetrics(m);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // Defer the first state update to the task queue. This keeps the effect a
    // subscription/refresh boundary and avoids a synchronous cascading render
    // under the React hooks lint rule.
    const initial = window.setTimeout(() => void refresh(), 0);
    const id = setInterval(() => void refresh(), 2000);
    return () => {
      window.clearTimeout(initial);
      clearInterval(id);
    };
  }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch("/api/agentos/tasks", {
        method: "POST",
        body: JSON.stringify({ title: form.title || form.goal.split("\n").find((l) => l && !l.startsWith("#"))?.slice(0, 60) || "untitled", goal: form.goal, priority: Number(form.priority), budget: { maxRetries: Number(form.maxRetries) }, isolated: form.isolated, ...(form.workdir.trim() ? { workdir: form.workdir.trim() } : {}), start: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setForm((f) => ({ ...f, title: "" }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: string) => {
    try {
      await taskAction(id, action);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const visible = filter ? tasks.filter((t) => t.status === filter) : tasks;
  const active = tasks.filter((t) => ["PLANNING", "EXECUTING", "VERIFYING", "FIXING", "REVIEWING", "DIAGNOSING", "RETRYING"].includes(t.status));

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
      <ApprovalToaster />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">AgentOS</h1>
          <p className="text-sm text-slate-600">Local autonomous agent runtime — tasks, agents, tools, events, verification.</p>
        </div>
        <nav className="flex flex-wrap items-center gap-3 text-sm">
          <input
            type="password"
            placeholder="API key (scoped; stored in this browser only)"
            className="w-64 rounded-lg border border-slate-300 px-3 py-1.5"
            value={apiKeyValue}
            onChange={(e) => {
              setApiKeyValue(e.target.value);
              if (typeof window !== "undefined") {
                if (e.target.value) window.localStorage.setItem("agentos-api-key", e.target.value);
                else window.localStorage.removeItem("agentos-api-key");
              }
            }}
          />
          <a className="rounded-lg bg-white px-3 py-1.5 ring-1 ring-slate-200 hover:bg-slate-50" href="/api/agentos/metrics?format=prometheus" target="_blank">
            Prometheus
          </a>
          <a className="rounded-lg bg-white px-3 py-1.5 ring-1 ring-slate-200 hover:bg-slate-50" href="/api/agentos/doctor" target="_blank">
            Doctor
          </a>
          <a className="rounded-lg bg-white px-3 py-1.5 ring-1 ring-slate-200 hover:bg-slate-50" href="/api/agentos/tools" target="_blank">
            Tools
          </a>
          <Link className="rounded-lg bg-slate-900 px-3 py-1.5 font-semibold text-white hover:bg-slate-700" href="/chat">
            Chat
          </Link>
        </nav>
      </header>

      {error && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">{error}</div>}

      {metrics && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
          <Stat label="Running" value={metrics.running} sub={`${active.length} active / ${tasks.length} total`} />
          <Stat label="Completed" value={metrics.tasks.completed} sub={`avg ${fmtMs(metrics.tasks.durationMs.count ? metrics.tasks.durationMs.totalMs / metrics.tasks.durationMs.count : 0)}`} />
          <Stat label="Failed" value={metrics.tasks.failed} sub={`${metrics.tasks.retries} retries`} />
          <Stat label="Tests" value={`${Math.round(metrics.tests.passRate * 100)}%`} sub={`${metrics.tests.passed} pass / ${metrics.tests.failed} fail`} />
          <Stat label="Tool calls" value={Object.values(metrics.tools).reduce((a, t) => a + t.count, 0)} sub={`${Object.values(metrics.tools).reduce((a, t) => a + t.failed, 0)} failed`} />
          <Stat label="Events" value={metrics.persistedEvents} sub={`pending ${metrics.bus.pending}, dropped ${metrics.bus.droppedEvents}`} />
          <Stat label="Tokens" value={tasks.reduce((a, t) => a + t.usage.tokens, 0)} sub="LLM usage (0 = deterministic)" />
          <Stat label="Runtime" value={fmtMs(metrics.runtime.uptimeMs)} sub={`${(metrics.runtime.rssBytes / 1024 / 1024).toFixed(0)} MB RSS`} />
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 lg:col-span-1">
          <h2 className="text-lg font-semibold">New task</h2>
          <form onSubmit={submit} className="mt-3 space-y-3 text-sm">
            <input className="w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="Title (optional)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <textarea className="h-44 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs" value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-slate-600">
                Priority
                <input type="number" className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
              </label>
              <label className="text-xs text-slate-600">
                Max retries
                <input type="number" min={0} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1" value={form.maxRetries} onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })} />
              </label>
              <label className="flex items-end gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={form.isolated} onChange={(e) => setForm({ ...form, isolated: e.target.checked })} /> git worktree
              </label>
            </div>
            <input className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs" placeholder="Workdir (optional, relative to runtime root)" value={form.workdir} onChange={(e) => setForm({ ...form, workdir: e.target.value })} />
            <button disabled={busy} className="w-full rounded-lg bg-slate-900 px-3 py-2 font-semibold text-white hover:bg-slate-700 disabled:opacity-50">
              {busy ? "Creating…" : "Create & run"}
            </button>
            <p className="text-xs text-slate-500">DSL: write / append / mkdir / delete / run: / fetch / git: / verify: / check exists|contains|command. Set LLM_API_KEY to plan free-form goals.</p>
          </form>
        </section>

        <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Tasks</h2>
            <select className="rounded-lg border border-slate-300 px-2 py-1 text-sm" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All statuses</option>
              {Object.keys(STATUS_COLORS).map((s) => (
                <option key={s} value={s}>
                  {s} {metrics?.queue?.[s as TaskStatus] ? `(${metrics.queue[s as TaskStatus]})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-3 divide-y divide-slate-100">
            {visible.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No tasks yet.</p>}
            {visible.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-3 py-3">
                <StatusBadge status={t.status} />
                <Link href={`/tasks/${t.id}`} className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-900 hover:underline">{t.spec.title}</div>
                  <div className="truncate text-xs text-slate-500">
                    {t.id} · p{t.priority} · attempt {t.attempt} · {t.usage.toolCalls} tool calls · {fmtMs(t.usage.elapsedMs)}
                    {t.dependsOn.length ? ` · after ${t.dependsOn.length} dep(s)` : ""}
                    {t.error ? ` · ${t.error.slice(0, 80)}` : ""}
                  </div>
                </Link>
                <div className="flex gap-1 text-xs">
                  {["CREATED", "PAUSED"].includes(t.status) && (
                    <button onClick={() => act(t.id, t.status === "PAUSED" ? "resume" : "start")} className="rounded-md bg-emerald-600 px-2 py-1 text-white">
                      {t.status === "PAUSED" ? "Resume" : "Start"}
                    </button>
                  )}
                  {["PLANNING", "EXECUTING", "VERIFYING", "FIXING", "REVIEWING", "QUEUED"].includes(t.status) && (
                    <button onClick={() => act(t.id, "pause")} className="rounded-md bg-yellow-500 px-2 py-1 text-white">
                      Pause
                    </button>
                  )}
                  {!["COMPLETED", "FAILED", "CANCELLED", "BLOCKED"].includes(t.status) && (
                    <button onClick={() => act(t.id, "cancel")} className="rounded-md bg-rose-600 px-2 py-1 text-white">
                      Cancel
                    </button>
                  )}
                  {["FAILED", "CANCELLED", "BLOCKED"].includes(t.status) && (
                    <button onClick={() => act(t.id, "retry")} className="rounded-md bg-slate-700 px-2 py-1 text-white">
                      Retry
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {metrics && (
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="text-lg font-semibold">Tools</h2>
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th>Tool</th>
                  <th>Calls</th>
                  <th>Success</th>
                  <th>Avg</th>
                  <th>Max</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(metrics.tools).map(([name, t]) => (
                  <tr key={name} className="border-t border-slate-100">
                    <td className="py-1 font-mono">{name}</td>
                    <td>{t.count}</td>
                    <td>{Math.round(t.successRate * 100)}%</td>
                    <td>{fmtMs(t.count ? t.totalMs / t.count : 0)}</td>
                    <td>{fmtMs(t.maxMs)}</td>
                  </tr>
                ))}
                {Object.keys(metrics.tools).length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-2 text-slate-500">
                      No tool calls in this process yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="text-lg font-semibold">Agents</h2>
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th>Role</th>
                  <th>Runs</th>
                  <th>Failures</th>
                  <th>Avg</th>
                </tr>
              </thead>
              <tbody>
                {["planner", "researcher", "executor", "tester", "reviewer", "debugger", "integrator"].map((role) => {
                  const a = metrics.agents[role];
                  return (
                    <tr key={role} className="border-t border-slate-100">
                      <td className="py-1 font-mono">{role}</td>
                      <td>{a?.count ?? 0}</td>
                      <td>{a?.failures ?? 0}</td>
                      <td>{fmtMs(a?.count ? a.totalMs / a.count : 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
