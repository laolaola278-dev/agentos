import type { Task, TaskStatus } from "./types";
import { AgentOSError, TERMINAL_STATUSES } from "./types";

/**
 * Priority + dependency aware task queue. Pure data structure (no I/O), so it is trivially testable.
 * Higher `priority` runs first; ties are broken by creation time (FIFO).
 */
export class TaskQueue {
  private tasks = new Map<string, Task>();

  upsert(task: Task): void {
    this.tasks.set(task.id, task);
  }

  remove(id: string): void {
    this.tasks.delete(id);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  all(): Task[] {
    return [...this.tasks.values()];
  }

  size(): number {
    return this.tasks.size;
  }

  /** Throws if adding `task` would create a dependency cycle or reference an unknown task. */
  validateDependencies(task: Task, opts: { allowUnknown?: boolean } = {}): void {
    for (const dep of task.dependsOn) {
      if (dep === task.id) throw new AgentOSError("DEPENDENCY_CYCLE", `task ${task.id} depends on itself`);
      if (!this.tasks.has(dep) && !opts.allowUnknown) throw new AgentOSError("UNKNOWN_DEPENDENCY", `task ${task.id} depends on unknown task ${dep}`);
    }
    const visiting = new Set<string>();
    const visit = (id: string, path: string[]): void => {
      if (id === task.id && path.length > 0) throw new AgentOSError("DEPENDENCY_CYCLE", `dependency cycle: ${[...path, id].join(" -> ")}`);
      if (visiting.has(id)) return;
      visiting.add(id);
      const t = id === task.id ? task : this.tasks.get(id);
      for (const d of t?.dependsOn ?? []) visit(d, [...path, id]);
    };
    visit(task.id, []);
  }

  /** Dependencies that are not yet COMPLETED. */
  pendingDependencies(task: Task): string[] {
    return task.dependsOn.filter((d) => this.tasks.get(d)?.status !== "COMPLETED");
  }

  /** Dependencies that can never complete (FAILED / CANCELLED / BLOCKED / missing). */
  deadDependencies(task: Task): string[] {
    return task.dependsOn.filter((d) => {
      const t = this.tasks.get(d);
      return !t || t.status === "FAILED" || t.status === "CANCELLED" || t.status === "BLOCKED";
    });
  }

  /** QUEUED tasks whose dependencies are all COMPLETED, best first. */
  ready(): Task[] {
    return this.all()
      .filter((t) => t.status === "QUEUED" && this.pendingDependencies(t).length === 0)
      .sort((a, b) => b.priority - a.priority || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  /** QUEUED tasks with a dead dependency — they should be marked BLOCKED. */
  blocked(): Task[] {
    return this.all().filter((t) => t.status === "QUEUED" && this.deadDependencies(t).length > 0);
  }

  dependents(id: string): Task[] {
    return this.all().filter((t) => t.dependsOn.includes(id));
  }

  countByStatus(): Record<TaskStatus, number> {
    const out = {} as Record<TaskStatus, number>;
    for (const t of this.tasks.values()) out[t.status] = (out[t.status] ?? 0) + 1;
    return out;
  }

  isTerminal(id: string): boolean {
    const t = this.tasks.get(id);
    return !!t && TERMINAL_STATUSES.includes(t.status);
  }
}
