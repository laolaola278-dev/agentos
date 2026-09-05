import { pgTable, serial, text, integer, jsonb, timestamp, index, bigint } from "drizzle-orm/pg-core";

export const agentosTasks = pgTable(
  "agentos_tasks",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    priority: integer("priority").notNull().default(0),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    data: jsonb("data").notNull(),
  },
  (t) => [index("agentos_tasks_status_idx").on(t.status), index("agentos_tasks_created_idx").on(t.createdAt)],
);

export const agentosEvents = pgTable(
  "agentos_events",
  {
    id: serial("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    taskId: text("task_id"),
    agentId: text("agent_id"),
    type: text("type").notNull(),
    tool: text("tool"),
    args: jsonb("args"),
    result: jsonb("result"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    data: jsonb("data"),
  },
  (t) => [index("agentos_events_task_idx").on(t.taskId, t.id), index("agentos_events_type_idx").on(t.type)],
);

export const agentosCheckpoints = pgTable("agentos_checkpoints", {
  taskId: text("task_id").primaryKey(),
  version: integer("version").notNull(),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull(),
  data: jsonb("data").notNull(),
});
