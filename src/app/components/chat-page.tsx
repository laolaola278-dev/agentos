"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AgentEvent } from "@/agentos/types";

/**
 * Chat-style frontend for the agentic loop (DeepSeek-harness-like): each
 * message becomes an agentic task; the SSE event stream renders model deltas
 * and tool calls live. Session turns persist server-side (chat-session.json)
 * and replay as transcript on --resume semantics via /api/agentos/chat.
 */

interface TurnMessage {
  role: "user" | "assistant";
  content: string;
  taskId?: string;
}

const GATE = { noModel: "此服务未配置 LLM — 在 .env 或保管库设置 LLM_API_KEY 后重启（或在终端使用 agentos chat）" };

export default function ChatPage() {
  const [messages, setMessages] = useState<TurnMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<{ kind: "delta" | "tool"; text: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const key = () => (typeof window === "undefined" ? "" : window.localStorage.getItem("agentos-api-key") ?? "");
  const authHeaders = () => {
    const k = key();
    return { "content-type": "application/json", ...(k ? { authorization: `Bearer ${k}` } : {}) };
  };

  // load prior session transcript
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/agentos/chat", { headers: authHeaders() });
        const body = (await res.json()) as { turns?: { goal: string; status: string; assistant?: string }[]; error?: string; noModel?: boolean };
        if (body.noModel) setError(GATE.noModel);
        const turns = (body.turns ?? [])
          .filter((t) => t.goal)
          .flatMap((t) => [
            { role: "user" as const, content: t.goal },
            { role: "assistant" as const, content: t.assistant ?? `[${t.status}]` },
          ]);
        if (turns.length) setMessages(turns);
      } catch {
        // transcript load is best-effort
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, live]);

  const send = useCallback(
    async (text: string) => {
      const goal = text.trim();
      if (!goal || busy) return;
      setBusy(true);
      setError(null);
      setLive([]);
      setMessages((m) => [...m, { role: "user", content: goal }]);
      try {
        const res = await fetch("/api/agentos/chat", { method: "POST", headers: authHeaders(), body: JSON.stringify({ goal }) });
        const started = (await res.json()) as { taskId?: string; error?: string; noModel?: boolean };
        if (!res.ok || !started.taskId) throw new Error(started.noModel ? GATE.noModel : started.error ?? res.statusText);
        const taskId = started.taskId;

        // live SSE tail for this task: model deltas + tool activity
        const es = new EventSource(`/api/agentos/events/stream?taskId=${encodeURIComponent(taskId)}`);
        const seen = new Set<string>();
        es.addEventListener("event", (ev) => {
          try {
            const e = JSON.parse((ev as MessageEvent).data) as AgentEvent;
            if (e.id && seen.has(String(e.id))) return;
            if (e.id) seen.add(String(e.id));
            if (e.type === "model.delta") setLive((l) => [...l.slice(-80), { kind: "delta", text: String((e.data as { text?: string } | undefined)?.text ?? "") }]);
            else if (e.type === "agent.tool_call") setLive((l) => [...l.slice(-40), { kind: "tool", text: `⚙ ${(e.args as { action?: string } | undefined)?.action ?? e.tool ?? ""}` }]);
            else if (e.type === "tool.failed") setLive((l) => [...l.slice(-40), { kind: "tool", text: `✗ ${e.tool}: ${e.error ?? ""}` }]);
          } catch {
            // ignore malformed frames
          }
        });
        es.addEventListener("task", (ev) => {
          try {
            const t = JSON.parse((ev as MessageEvent).data) as { status?: string; result?: { finalMessage?: string; summary?: string } };
            if (t.status === "COMPLETED" || t.status === "FAILED") {
              es.close();
              setLive([]);
              setMessages((m) => [...m, { role: "assistant", content: t.result?.finalMessage ?? t.result?.summary ?? `[${t.status}]`, taskId }]);
              setBusy(false);
            }
          } catch {
            // ignore
          }
        });
        es.onerror = () => {
          /* the stream route closes on task end; completion is handled by the task event */
        };
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      } finally {
        setInput("");
      }
    },
    [busy],
  );

  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col px-6 py-6">
      <header className="flex items-center justify-between pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">AgentOS Chat</h1>
          <p className="text-xs text-slate-500">对话式自治代理 — 每条消息驱动一个 agentic 任务，工具调用实时展示（需 LLM）</p>
        </div>
        <Link href="/" className="rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-slate-200 hover:bg-slate-50">
          ← 仪表盘
        </Link>
      </header>

      {error && <div className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-amber-200">{error}</div>}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        {messages.length === 0 && !busy && <p className="py-10 text-center text-sm text-slate-400">输入一个目标开始 — 例如「在 workspace 写一个 date 工具并验证」</p>}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${m.role === "user" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-800"}`}>
              {m.content}
              {m.taskId && (
                <Link href={`/tasks/${m.taskId}`} className="ml-2 align-middle text-[11px] text-sky-600 hover:underline">
                  任务详情 →
                </Link>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl bg-slate-50 px-4 py-2 text-sm text-slate-600 ring-1 ring-slate-200">
              {live.length === 0 && <span className="animate-pulse">思考中…</span>}
              {live.map((l, i) => (
                <span key={i} className={l.kind === "tool" ? "mr-1 rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-800" : ""}>
                  {l.text}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          className="flex-1 rounded-xl border border-slate-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          placeholder={busy ? "任务运行中…" : "描述你的目标（agentic 模式，自动执行并验证）"}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
        />
        <button disabled={busy || !input.trim()} className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40">
          发送
        </button>
      </form>
    </div>
  );
}
