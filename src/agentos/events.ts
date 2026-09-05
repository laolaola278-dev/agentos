import type { AgentEvent, EventFilter, EventInput } from "./types";
import { nowIso } from "./types";
import { redactSecrets } from "./security";
import { matchesEvent, type Persistence, JsonlAppender, Mutex } from "./persistence";

export type EventHandler = (event: AgentEvent) => void | Promise<void>;

interface Subscription {
  handler: EventHandler;
  filter: EventFilter;
}

/**
 * Central event bus. Every event is redacted, sequenced, persisted and fanned out
 * to in-process subscribers. Persistence failures never propagate to emitters:
 * events are buffered (bounded) and retried on the next emit / flush.
 */
export class EventBus {
  private subs = new Set<Subscription>();
  private seq = 0;
  private pending: AgentEvent[] = [];
  private maxPending: number;
  droppedEvents = 0;
  persistErrors = 0;
  private lastPersistError: string | null = null;
  private mirror: JsonlAppender | null = null;
  private mutex = new Mutex();

  constructor(
    private store: Persistence,
    opts: { maxPending?: number; jsonlMirror?: string } = {},
  ) {
    this.maxPending = opts.maxPending ?? 10_000;
    if (opts.jsonlMirror) this.mirror = new JsonlAppender(opts.jsonlMirror);
  }

  get stats() {
    return {
      seq: this.seq,
      pending: this.pending.length,
      droppedEvents: this.droppedEvents,
      persistErrors: this.persistErrors,
      lastPersistError: this.lastPersistError,
      subscribers: this.subs.size,
    };
  }

  async emit(input: EventInput): Promise<AgentEvent> {
    // Persist and dispatch in sequence. Without this gate, concurrent agent
    // calls can obtain monotonically increasing seq values but reach a remote
    // store in a different order, producing an event timeline that cannot be
    // replayed deterministically.
    return this.mutex.run(() => this.emitSerial(input));
  }

  private async emitSerial(input: EventInput): Promise<AgentEvent> {
    const event: AgentEvent = {
      ...input,
      seq: ++this.seq,
      ts: input.ts ?? nowIso(),
      args: input.args === undefined ? undefined : redactSecrets(input.args),
      result: input.result === undefined ? undefined : redactSecrets(input.result),
      error: input.error ? (redactSecrets(input.error) as string) : input.error,
      data: input.data === undefined ? undefined : redactSecrets(input.data),
    };
    let stored = event;
    if (this.pending.length > 0) await this.flushPendingSerial();
    try {
      stored = await this.store.appendEvent(event);
    } catch (err) {
      this.persistErrors++;
      this.lastPersistError = err instanceof Error ? err.message : String(err);
      if (this.pending.length >= this.maxPending) {
        this.pending.shift();
        this.droppedEvents++;
      }
      this.pending.push(event);
    }
    if (this.mirror) {
      this.mirror.append(stored).catch(() => {
        this.persistErrors++;
      });
    }
    this.dispatch(stored);
    return stored;
  }

  /** Attempts to persist buffered events. Returns number still pending. */
  async flushPending(): Promise<number> {
    return this.mutex.run(() => this.flushPendingSerial());
  }

  private async flushPendingSerial(): Promise<number> {
    while (this.pending.length > 0) {
      const next = this.pending[0];
      try {
        await this.store.appendEvent(next);
        this.pending.shift();
      } catch (err) {
        this.lastPersistError = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    return this.pending.length;
  }

  private dispatch(event: AgentEvent): void {
    for (const sub of this.subs) {
      if (!matchesEvent(event, sub.filter)) continue;
      try {
        const r = sub.handler(event);
        if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => undefined);
      } catch {
        // subscriber errors must never break the emitter
      }
    }
  }

  subscribe(handler: EventHandler, filter: EventFilter = {}): () => void {
    const sub: Subscription = { handler, filter };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  /** Async-iterable live stream of events. Ends when `signal` aborts. */
  async *stream(filter: EventFilter = {}, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const queue: AgentEvent[] = [];
    let notify: (() => void) | null = null;
    const unsubscribe = this.subscribe((e) => {
      queue.push(e);
      notify?.();
    }, filter);
    const onAbort = () => notify?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (!signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
          continue;
        }
        yield queue.shift()!;
      }
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    }
  }

  query(filter: EventFilter = {}): Promise<AgentEvent[]> {
    return this.store.queryEvents(filter);
  }

  /** Replays persisted events (in order) into `handler`. Returns count replayed. */
  async replay(filter: EventFilter, handler: EventHandler): Promise<number> {
    const events = await this.store.queryEvents(filter);
    for (const e of events) await handler(e);
    return events.length;
  }

  /** Aligns the in-memory sequence with what is already persisted (used after restart). */
  async syncSequence(): Promise<void> {
    const last = await this.store.queryEvents({ limit: 1 });
    if (last.length) this.seq = Math.max(this.seq, last[0].seq);
  }
}
