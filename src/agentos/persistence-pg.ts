import { and, desc, eq, gt, inArray, like, sql, count } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { agentosCheckpoints, agentosEvents, agentosTasks } from "@/db/schema";
import type { AgentEvent, Checkpoint, EventFilter, Task } from "./types";
import { isCheckpointRecord, isTaskRecord, type Persistence, type TaskListFilter } from "./persistence";

/** PostgreSQL persistence via Drizzle — used by the Next.js dashboard and `--store pg`. */
export class PgPersistence implements Persistence {
  readonly kind = "postgres";
  constructor(private db: NodePgDatabase) {}

  async init(): Promise<void> {
    // Tables are created by `drizzle-kit push`; make sure they exist so a fresh DB works without a migration step.
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS agentos_tasks (
        id text PRIMARY KEY, status text NOT NULL, priority integer NOT NULL DEFAULT 0, title text NOT NULL,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, data jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS agentos_tasks_status_idx ON agentos_tasks(status);
      CREATE INDEX IF NOT EXISTS agentos_tasks_created_idx ON agentos_tasks(created_at);
      CREATE TABLE IF NOT EXISTS agentos_events (
        id serial PRIMARY KEY, seq bigint NOT NULL, ts timestamptz NOT NULL, task_id text, agent_id text, type text NOT NULL,
        tool text, args jsonb, result jsonb, duration_ms integer, error text, data jsonb);
      CREATE INDEX IF NOT EXISTS agentos_events_task_idx ON agentos_events(task_id, id);
      CREATE INDEX IF NOT EXISTS agentos_events_type_idx ON agentos_events(type);
      CREATE TABLE IF NOT EXISTS agentos_checkpoints (
        task_id text PRIMARY KEY, version integer NOT NULL, saved_at timestamptz NOT NULL, data jsonb NOT NULL);
    `);
  }

  async close(): Promise<void> {
    /* pool is owned by src/db */
  }

  async appendEvent(e: AgentEvent): Promise<AgentEvent> {
    const [row] = await this.db
      .insert(agentosEvents)
      .values({
        seq: e.seq,
        ts: new Date(e.ts),
        taskId: e.taskId,
        agentId: e.agentId,
        type: e.type,
        tool: e.tool ?? null,
        args: e.args === undefined ? null : e.args,
        result: e.result === undefined ? null : e.result,
        durationMs: e.durationMs ?? null,
        error: e.error ?? null,
        data: e.data === undefined ? null : e.data,
      })
      .returning({ id: agentosEvents.id });
    return { ...e, id: row.id };
  }

  private where(f: EventFilter) {
    const conds = [];
    if (f.taskId) conds.push(eq(agentosEvents.taskId, f.taskId));
    if (f.agentId) conds.push(eq(agentosEvents.agentId, f.agentId));
    if (f.type) conds.push(eq(agentosEvents.type, f.type));
    if (f.typePrefix) conds.push(like(agentosEvents.type, `${f.typePrefix.replace(/[%_]/g, "\\$&")}%`));
    if (f.afterId !== undefined) conds.push(gt(agentosEvents.id, f.afterId));
    return conds.length ? and(...conds) : undefined;
  }

  async queryEvents(f: EventFilter = {}): Promise<AgentEvent[]> {
    const w = this.where(f);
    const limit = f.limit && f.limit > 0 ? f.limit : undefined;
    const rows = limit
      ? (await this.db.select().from(agentosEvents).where(w).orderBy(desc(agentosEvents.id)).limit(limit)).reverse()
      : await this.db.select().from(agentosEvents).where(w).orderBy(agentosEvents.id);
    return rows.map((r) => ({
      id: r.id,
      seq: Number(r.seq),
      ts: r.ts.toISOString(),
      taskId: r.taskId,
      agentId: r.agentId,
      type: r.type,
      tool: r.tool,
      args: r.args ?? undefined,
      result: r.result ?? undefined,
      durationMs: r.durationMs,
      error: r.error,
      data: (r.data as Record<string, unknown> | null) ?? undefined,
    }));
  }

  async countEvents(f: EventFilter = {}): Promise<number> {
    const [row] = await this.db.select({ c: count() }).from(agentosEvents).where(this.where(f));
    return Number(row.c);
  }

  async saveTask(task: Task): Promise<void> {
    const values = {
      id: task.id,
      status: task.status,
      priority: task.priority,
      title: task.spec.title,
      createdAt: new Date(task.createdAt),
      updatedAt: new Date(task.updatedAt),
      data: task as unknown as Record<string, unknown>,
    };
    await this.db
      .insert(agentosTasks)
      .values(values)
      .onConflictDoUpdate({ target: agentosTasks.id, set: { status: values.status, priority: values.priority, title: values.title, updatedAt: values.updatedAt, data: values.data } });
  }

  async getTask(id: string): Promise<Task | null> {
    const [row] = await this.db.select({ data: agentosTasks.data }).from(agentosTasks).where(eq(agentosTasks.id, id));
    return row && isTaskRecord(row.data) ? row.data : null;
  }

  async listTasks(f: TaskListFilter = {}): Promise<Task[]> {
    const q = this.db.select({ data: agentosTasks.data }).from(agentosTasks).orderBy(desc(agentosTasks.createdAt));
    const rows = f.status && f.status.length ? await q.where(inArray(agentosTasks.status, f.status)).limit(f.limit ?? 10_000) : await q.limit(f.limit ?? 10_000);
    return rows.flatMap((r) => (isTaskRecord(r.data) ? [r.data] : []));
  }

  async deleteTask(id: string): Promise<void> {
    await this.db.delete(agentosTasks).where(eq(agentosTasks.id, id));
  }

  async saveCheckpoint(cp: Checkpoint): Promise<void> {
    const values = { taskId: cp.taskId, version: cp.version, savedAt: new Date(cp.savedAt || Date.now()), data: cp as unknown as Record<string, unknown> };
    await this.db.insert(agentosCheckpoints).values(values).onConflictDoUpdate({ target: agentosCheckpoints.taskId, set: { version: values.version, savedAt: values.savedAt, data: values.data } });
  }

  async loadCheckpoint(taskId: string): Promise<Checkpoint | null> {
    const [row] = await this.db.select({ data: agentosCheckpoints.data }).from(agentosCheckpoints).where(eq(agentosCheckpoints.taskId, taskId));
    return row && isCheckpointRecord(row.data) ? row.data : null;
  }

  async listCheckpoints(): Promise<Checkpoint[]> {
    const rows = await this.db.select({ data: agentosCheckpoints.data }).from(agentosCheckpoints).orderBy(desc(agentosCheckpoints.savedAt));
    return rows.flatMap((r) => (isCheckpointRecord(r.data) ? [r.data] : []));
  }

  async deleteCheckpoint(taskId: string): Promise<void> {
    await this.db.delete(agentosCheckpoints).where(eq(agentosCheckpoints.taskId, taskId));
  }
}
