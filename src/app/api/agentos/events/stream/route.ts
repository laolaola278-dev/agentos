import { getServerRuntime } from "@/agentos/server";
import { redactSecrets } from "@/agentos/security";

export const dynamic = "force-dynamic";

/** Server-Sent Events: replays recent events, then streams new ones (polling the store so CLI-produced events show up too). */
export async function GET(req: Request) {
  const rt = await getServerRuntime();
  const p = new URL(req.url).searchParams;
  const taskId = p.get("taskId") ?? undefined;
  const typePrefix = p.get("typePrefix") ?? undefined;
  let lastId = p.get("afterId") ? Number(p.get("afterId")) : 0;
  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(redactSecrets(data))}\n\n`));
        } catch {
          closed = true;
        }
      };
      const poll = async () => {
        if (closed) return;
        try {
          const events = await rt.bus.query({ taskId, typePrefix, afterId: lastId, limit: lastId === 0 ? 100 : 500 });
          for (const e of events) {
            send("event", e);
            lastId = Math.max(lastId, e.id ?? lastId);
          }
          if (taskId) {
            const t = rt.getTask(taskId) ?? (await rt.persistence.getTask(taskId));
            if (t) send("task", { ...t, result: undefined });
          }
        } catch (err) {
          send("error", { message: err instanceof Error ? err.message : String(err) });
        }
      };
      await poll();
      timer = setInterval(() => {
        void poll();
        send("ping", { ts: Date.now() });
      }, 1000);
      req.signal.addEventListener("abort", () => {
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}
