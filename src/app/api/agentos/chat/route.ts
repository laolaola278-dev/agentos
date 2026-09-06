import { getServerRuntime } from "@/agentos/server";
import { loadChatSession, saveChatSession } from "@/agentos/chat";
import fsp from "node:fs/promises";
import path from "node:path";
import { fail, json } from "@/app/api/agentos/_util";

export const dynamic = "force-dynamic";

/** Prior session turns (transcript-level resume for the chat UI). */
export async function GET() {
  try {
    const rt = await getServerRuntime();
    const turns = (await loadChatSession(rt.dataDir)) ?? [];
    return json({ noModel: !rt.model ? true : undefined, turns: turns.map((t) => ({ goal: t.goal, status: t.status, assistant: t.assistant ?? t.summary })) });
  } catch (err) {
    return fail(err, 500);
  }
}

/** Start an agentic chat turn: creates the task (transcript-seeded) and returns its id. */
export async function POST(req: Request) {
  try {
    const { goal } = (await req.json()) as { goal?: string };
    if (!goal || !goal.trim()) return json({ error: "goal required" }, { status: 400 });
    const rt = await getServerRuntime();
    if (!rt.model?.completeWithTools) {
      return json({ noModel: true, error: "no LLM configured — set LLM_API_KEY (secrets vault or .env) and restart" }, { status: 503 });
    }
    const { sessionContextMessages } = await import("@/agentos/chat");
    const prior = (await loadChatSession(rt.dataDir)) ?? [];
    const context = sessionContextMessages(prior);
    const task = await rt.createTask({
      title: goal.slice(0, 80),
      goal,
      mode: "agentic",
      context: context.length ? context : undefined,
      budget: { maxToolCalls: 100, timeoutMs: 10 * 60_000 },
    });
    await rt.startTask(task.id);
    return json({ taskId: task.id, status: task.status });
  } catch (err) {
    return fail(err, 500);
  }
}

/** Persist a finished turn (called by the stream route's completion, or manually). Kept small on purpose. */
export async function PUT(req: Request) {
  try {
    const rt = await getServerRuntime();
    const { goal, status, summary } = (await req.json()) as { goal?: string; status?: string; summary?: string };
    if (!goal) return json({ error: "goal required" }, { status: 400 });
    await saveChatSession(rt.dataDir, { ts: new Date().toISOString(), goal, status: status ?? "COMPLETED", summary });
    return json({ saved: true });
  } catch (err) {
    return fail(err, 500);
  }
}

void fsp;
void path;
