import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent, Checkpoint, EventFilter, Task, TaskStatus } from "./types";

export interface TaskListFilter {
  status?: TaskStatus[];
  limit?: number;
}

/** Storage abstraction for tasks, events and checkpoints. */
export interface Persistence {
  readonly kind: string;
  init(): Promise<void>;
  close(): Promise<void>;
  appendEvent(event: AgentEvent): Promise<AgentEvent>;
  queryEvents(filter?: EventFilter): Promise<AgentEvent[]>;
  countEvents(filter?: EventFilter): Promise<number>;
  saveTask(task: Task): Promise<void>;
  getTask(id: string): Promise<Task | null>;
  listTasks(filter?: TaskListFilter): Promise<Task[]>;
  deleteTask(id: string): Promise<void>;
  saveCheckpoint(cp: Checkpoint): Promise<void>;
  loadCheckpoint(taskId: string): Promise<Checkpoint | null>;
  listCheckpoints(): Promise<Checkpoint[]>;
  deleteCheckpoint(taskId: string): Promise<void>;
}

export function matchesEvent(e: AgentEvent, f: EventFilter): boolean {
  if (f.taskId && e.taskId !== f.taskId) return false;
  if (f.agentId && e.agentId !== f.agentId) return false;
  if (f.type && e.type !== f.type) return false;
  if (f.typePrefix && !e.type.startsWith(f.typePrefix)) return false;
  if (f.afterId !== undefined && (e.id ?? 0) <= f.afterId) return false;
  return true;
}

function applyLimit<T>(arr: T[], limit?: number): T[] {
  if (!limit || limit <= 0) return arr;
  return arr.length > limit ? arr.slice(arr.length - limit) : arr;
}

function sortTasks(tasks: Task[]): Task[] {
  return tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Simple async mutex used to serialise file writes. */
export class Mutex {
  private chain: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// A mutex per destination protects atomic replacements even when several tool
// calls use different persistence/tool instances.  POSIX rename(2) replaces an
// existing file, while Windows' MoveFileEx wrapper generally returns EEXIST or
// EPERM; serialising the complete temp-write/replace sequence gives both
// platforms the same no-torn-write guarantee.
const fileMutexes = new Map<string, Mutex>();

function fileMutex(file: string): Mutex {
  const key = path.resolve(file);
  let mutex = fileMutexes.get(key);
  if (!mutex) {
    mutex = new Mutex();
    fileMutexes.set(key, mutex);
  }
  return mutex;
}

async function replaceFile(tmp: string, file: string): Promise<void> {
  try {
    await fsp.rename(tmp, file);
    return;
  } catch (err) {
    // Windows cannot rename over an existing destination.  Retry a few times
    // because antivirus/indexer handles can briefly hold either path open.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (process.platform !== "win32" || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(String(code))) throw err;
    let last = err;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fsp.rm(file, { force: true });
        await fsp.rename(tmp, file);
        return;
      } catch (next) {
        last = next;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
    throw last;
  }
}

export async function atomicWriteFile(file: string, content: string): Promise<void> {
  return fileMutex(file).run(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    let replaced = false;
    try {
      const handle = await fsp.open(tmp, "w");
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await replaceFile(tmp, file);
      replaced = true;
    } finally {
      if (!replaced) await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export class MemoryPersistence implements Persistence {
  readonly kind: string = "memory";
  protected events: AgentEvent[] = [];
  protected tasks = new Map<string, Task>();
  protected checkpoints = new Map<string, Checkpoint>();
  protected nextId = 1;

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async appendEvent(event: AgentEvent): Promise<AgentEvent> {
    const stored = { ...event, id: this.nextId++ };
    this.events.push(stored);
    return stored;
  }
  async queryEvents(filter: EventFilter = {}): Promise<AgentEvent[]> {
    return applyLimit(
      this.events.filter((e) => matchesEvent(e, filter)),
      filter.limit,
    );
  }
  async countEvents(filter: EventFilter = {}): Promise<number> {
    return this.events.filter((e) => matchesEvent(e, filter)).length;
  }
  async saveTask(task: Task): Promise<void> {
    this.tasks.set(task.id, structuredClone(task));
  }
  async getTask(id: string): Promise<Task | null> {
    const t = this.tasks.get(id);
    return t ? structuredClone(t) : null;
  }
  async listTasks(filter: TaskListFilter = {}): Promise<Task[]> {
    let all = [...this.tasks.values()].map((t) => structuredClone(t));
    if (filter.status) all = all.filter((t) => filter.status!.includes(t.status));
    all = sortTasks(all);
    return filter.limit ? all.slice(0, filter.limit) : all;
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async saveCheckpoint(cp: Checkpoint): Promise<void> {
    this.checkpoints.set(cp.taskId, structuredClone(cp));
  }
  async loadCheckpoint(taskId: string): Promise<Checkpoint | null> {
    const c = this.checkpoints.get(taskId);
    return c ? structuredClone(c) : null;
  }
  async listCheckpoints(): Promise<Checkpoint[]> {
    return [...this.checkpoints.values()].map((c) => structuredClone(c));
  }
  async deleteCheckpoint(taskId: string): Promise<void> {
    this.checkpoints.delete(taskId);
  }
}

// ---------------------------------------------------------------------------
// JSONL appender (used standalone as an audit log and by FilePersistence)
// ---------------------------------------------------------------------------

export class JsonlAppender {
  private mutex = new Mutex();
  constructor(readonly file: string) {}

  async append(obj: unknown): Promise<void> {
    const line = JSON.stringify(obj) + "\n";
    // Use both the instance lock (fast path) and the process-wide destination
    // lock so separate appenders cannot interleave writes.
    await this.mutex.run(async () => fileMutex(this.file).run(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.appendFile(this.file, line, "utf8");
    }));
  }

  /** Reads all complete JSON lines. Tolerates a truncated/corrupt trailing line (partial write). */
  async readAll<T = unknown>(): Promise<{ records: T[]; corruptLines: number }> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], corruptLines: 0 };
      throw err;
    }
    const records: T[] = [];
    let corruptLines = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as T);
      } catch {
        corruptLines++;
      }
    }
    return { records, corruptLines };
  }
}

// ---------------------------------------------------------------------------
// File based: events.jsonl + tasks/*.json + checkpoints/*.json
// ---------------------------------------------------------------------------

export class FilePersistence extends MemoryPersistence implements Persistence {
  override readonly kind = "file";
  private appender: JsonlAppender;
  private mutex = new Mutex();
  corruptEventLines = 0;

  constructor(readonly dir: string) {
    super();
    this.appender = new JsonlAppender(path.join(dir, "events.jsonl"));
  }

  override async init(): Promise<void> {
    await fsp.mkdir(path.join(this.dir, "tasks"), { recursive: true });
    await fsp.mkdir(path.join(this.dir, "checkpoints"), { recursive: true });
    const { records, corruptLines } = await this.appender.readAll<AgentEvent>();
    this.corruptEventLines = corruptLines;
    this.events = records;
    this.nextId = records.reduce((m, e) => Math.max(m, e.id ?? 0), 0) + 1;
    for (const f of await fsp.readdir(path.join(this.dir, "tasks"))) {
      if (!f.endsWith(".json")) continue;
      const t = await readJson<Task>(path.join(this.dir, "tasks", f));
      if (t && isTaskRecord(t)) this.tasks.set(t.id, t);
    }
    for (const f of await fsp.readdir(path.join(this.dir, "checkpoints"))) {
      if (!f.endsWith(".json")) continue;
      const c = await readJson<Checkpoint>(path.join(this.dir, "checkpoints", f));
      if (c && isCheckpointRecord(c)) this.checkpoints.set(c.taskId, c);
    }
  }

  override async appendEvent(event: AgentEvent): Promise<AgentEvent> {
    const stored = await super.appendEvent(event);
    await this.appender.append(stored);
    return stored;
  }
  override async saveTask(task: Task): Promise<void> {
    await super.saveTask(task);
    await this.mutex.run(() => atomicWriteFile(path.join(this.dir, "tasks", `${safeName(task.id)}.json`), JSON.stringify(task, null, 2)));
  }
  override async deleteTask(id: string): Promise<void> {
    await super.deleteTask(id);
    await fsp.rm(path.join(this.dir, "tasks", `${safeName(id)}.json`), { force: true });
  }
  override async saveCheckpoint(cp: Checkpoint): Promise<void> {
    await super.saveCheckpoint(cp);
    await this.mutex.run(() =>
      atomicWriteFile(path.join(this.dir, "checkpoints", `${safeName(cp.taskId)}.json`), JSON.stringify(cp, null, 2)),
    );
  }
  override async deleteCheckpoint(taskId: string): Promise<void> {
    await super.deleteCheckpoint(taskId);
    await fsp.rm(path.join(this.dir, "checkpoints", `${safeName(taskId)}.json`), { force: true });
  }
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch {
    return null; // corrupt file (e.g. partial write) — skipped, logged by caller via doctor
  }
}

export function isTaskRecord(value: unknown): value is Task {
  const v = value as Partial<Task> | null;
  return !!v && typeof v === "object" && typeof v.id === "string" && typeof v.status === "string" && !!v.spec && typeof v.spec === "object";
}

export function isCheckpointRecord(value: unknown): value is Checkpoint {
  const v = value as Partial<Checkpoint> | null;
  return !!v && typeof v === "object" && typeof v.taskId === "string" && typeof v.phase === "string" && Array.isArray(v.completedSteps) && Array.isArray(v.messages);
}

// ---------------------------------------------------------------------------
// SQLite (node:sqlite, built into Node >= 22.13)
// ---------------------------------------------------------------------------

export class SqlitePersistence implements Persistence {
  readonly kind = "sqlite";
  private db: DatabaseSync | null = null;

  constructor(readonly file: string = ":memory:") {}

  private get conn(): DatabaseSync {
    if (!this.db) throw new Error("SqlitePersistence not initialised — call init()");
    return this.db;
  }

  async init(): Promise<void> {
    if (this.file !== ":memory:") fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    if (this.file !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        task_id TEXT,
        agent_id TEXT,
        type TEXT NOT NULL,
        tool TEXT,
        args TEXT,
        result TEXT,
        duration_ms INTEGER,
        error TEXT,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE TABLE IF NOT EXISTS checkpoints (
        task_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        saved_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async appendEvent(event: AgentEvent): Promise<AgentEvent> {
    const stmt = this.conn.prepare(
      `INSERT INTO events (seq, ts, task_id, agent_id, type, tool, args, result, duration_ms, error, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const r = stmt.run(
      event.seq,
      event.ts,
      event.taskId,
      event.agentId,
      event.type,
      event.tool ?? null,
      event.args === undefined ? null : JSON.stringify(event.args),
      event.result === undefined ? null : JSON.stringify(event.result),
      event.durationMs ?? null,
      event.error ?? null,
      event.data === undefined ? null : JSON.stringify(event.data),
    );
    return { ...event, id: Number(r.lastInsertRowid) };
  }

  async queryEvents(filter: EventFilter = {}): Promise<AgentEvent[]> {
    const { where, params } = this.buildWhere(filter);
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 0;
    const sql = limit
      ? `SELECT * FROM (SELECT * FROM events ${where} ORDER BY id DESC LIMIT ${limit}) ORDER BY id ASC`
      : `SELECT * FROM events ${where} ORDER BY id ASC`;
    const rows = this.conn.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  async countEvents(filter: EventFilter = {}): Promise<number> {
    const { where, params } = this.buildWhere(filter);
    const row = this.conn.prepare(`SELECT COUNT(*) AS c FROM events ${where}`).get(...params) as { c: number };
    return Number(row.c);
  }

  private buildWhere(f: EventFilter): { where: string; params: (string | number)[] } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (f.taskId) (clauses.push("task_id = ?"), params.push(f.taskId));
    if (f.agentId) (clauses.push("agent_id = ?"), params.push(f.agentId));
    if (f.type) (clauses.push("type = ?"), params.push(f.type));
    if (f.typePrefix) (clauses.push("type LIKE ?"), params.push(`${f.typePrefix}%`));
    if (f.afterId !== undefined) (clauses.push("id > ?"), params.push(f.afterId));
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  async saveTask(task: Task): Promise<void> {
    this.conn
      .prepare(
        `INSERT INTO tasks (id, status, priority, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, priority = excluded.priority,
         updated_at = excluded.updated_at, data = excluded.data`,
      )
      .run(task.id, task.status, task.priority, task.createdAt, task.updatedAt, JSON.stringify(task));
  }
  async getTask(id: string): Promise<Task | null> {
    const row = this.conn.prepare("SELECT data FROM tasks WHERE id = ?").get(id) as { data: string } | undefined;
    if (!row) return null;
    try {
      const value = JSON.parse(row.data);
      return isTaskRecord(value) ? value : null;
    } catch {
      return null;
    }
  }
  async listTasks(filter: TaskListFilter = {}): Promise<Task[]> {
    let sql = "SELECT data FROM tasks";
    const params: string[] = [];
    if (filter.status && filter.status.length) {
      sql += ` WHERE status IN (${filter.status.map(() => "?").join(",")})`;
      params.push(...filter.status);
    }
    sql += " ORDER BY created_at DESC";
    if (filter.limit) sql += ` LIMIT ${Math.max(1, Math.floor(filter.limit))}`;
    const rows = this.conn.prepare(sql).all(...params) as { data: string }[];
    return rows.flatMap((r) => {
      try {
        const value = JSON.parse(r.data);
        return isTaskRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
  }
  async deleteTask(id: string): Promise<void> {
    this.conn.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }
  async saveCheckpoint(cp: Checkpoint): Promise<void> {
    this.conn
      .prepare(
        `INSERT INTO checkpoints (task_id, version, saved_at, data) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET version = excluded.version, saved_at = excluded.saved_at, data = excluded.data`,
      )
      .run(cp.taskId, cp.version, cp.savedAt, JSON.stringify(cp));
  }
  async loadCheckpoint(taskId: string): Promise<Checkpoint | null> {
    const row = this.conn.prepare("SELECT data FROM checkpoints WHERE task_id = ?").get(taskId) as { data: string } | undefined;
    if (!row) return null;
    try {
      const value = JSON.parse(row.data);
      return isCheckpointRecord(value) ? value : null;
    } catch {
      return null;
    }
  }
  async listCheckpoints(): Promise<Checkpoint[]> {
    const rows = this.conn.prepare("SELECT data FROM checkpoints ORDER BY saved_at DESC").all() as { data: string }[];
    return rows.flatMap((r) => {
      try {
        const value = JSON.parse(r.data);
        return isCheckpointRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
  }
  async deleteCheckpoint(taskId: string): Promise<void> {
    this.conn.prepare("DELETE FROM checkpoints WHERE task_id = ?").run(taskId);
  }
}

function rowToEvent(r: Record<string, unknown>): AgentEvent {
  const parse = (v: unknown) => {
    if (typeof v !== "string") return v ?? undefined;
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  };
  return {
    id: Number(r.id),
    seq: Number(r.seq),
    ts: String(r.ts),
    taskId: (r.task_id as string | null) ?? null,
    agentId: (r.agent_id as string | null) ?? null,
    type: String(r.type),
    tool: (r.tool as string | null) ?? null,
    args: parse(r.args),
    result: parse(r.result),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    error: (r.error as string | null) ?? null,
    data: parse(r.data) as Record<string, unknown> | undefined,
  };
}
