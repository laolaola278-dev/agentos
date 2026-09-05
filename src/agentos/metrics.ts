import type { AgentEvent } from "./types";
import type { EventBus } from "./events";

interface Timing {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface MetricsSnapshot {
  tasks: { created: number; completed: number; failed: number; cancelled: number; retries: number; fixes: number; durationMs: Timing };
  agents: Record<string, Timing & { failures: number }>;
  tools: Record<string, Timing & { success: number; failed: number; successRate: number }>;
  tests: { started: number; passed: number; failed: number; passRate: number };
  events: { total: number; byType: Record<string, number> };
  runtime: { uptimeMs: number; rssBytes: number; heapUsedBytes: number };
}

/** In-process metrics collector fed by the event bus. Cheap O(1) updates. */
export class MetricsCollector {
  private startedAt = Date.now();
  private counters: Record<string, number> = {};
  private taskDuration: Timing = { count: 0, totalMs: 0, maxMs: 0 };
  private agentTimings = new Map<string, Timing & { failures: number }>();
  private toolTimings = new Map<string, Timing & { success: number; failed: number }>();
  private tests = { started: 0, passed: 0, failed: 0 };
  private taskStart = new Map<string, number>();
  private agentStart = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  attach(bus: EventBus): this {
    this.unsubscribe = bus.subscribe((e) => this.record(e));
    return this;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  record(e: AgentEvent): void {
    this.counters[e.type] = (this.counters[e.type] ?? 0) + 1;
    const ts = Date.parse(e.ts);
    switch (e.type) {
      case "task.started":
        if (e.taskId) this.taskStart.set(e.taskId, ts);
        break;
      case "task.completed":
      case "task.failed":
      case "task.cancelled": {
        const start = e.taskId ? this.taskStart.get(e.taskId) : undefined;
        const d = typeof e.durationMs === "number" ? e.durationMs : start ? ts - start : 0;
        this.taskDuration.count++;
        this.taskDuration.totalMs += d;
        this.taskDuration.maxMs = Math.max(this.taskDuration.maxMs, d);
        if (e.taskId) this.taskStart.delete(e.taskId);
        break;
      }
      case "agent.started":
        if (e.agentId) this.agentStart.set(e.agentId, ts);
        break;
      case "agent.completed":
      case "agent.failed": {
        const role = (e.data?.role as string) ?? "unknown";
        const t = this.agentTimings.get(role) ?? { count: 0, totalMs: 0, maxMs: 0, failures: 0 };
        const start = e.agentId ? this.agentStart.get(e.agentId) : undefined;
        const d = typeof e.durationMs === "number" ? e.durationMs : start ? ts - start : 0;
        t.count++;
        t.totalMs += d;
        t.maxMs = Math.max(t.maxMs, d);
        if (e.type === "agent.failed") t.failures++;
        this.agentTimings.set(role, t);
        if (e.agentId) this.agentStart.delete(e.agentId);
        break;
      }
      case "tool.completed":
      case "tool.failed": {
        const name = e.tool ?? "unknown";
        const t = this.toolTimings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, success: 0, failed: 0 };
        const d = e.durationMs ?? 0;
        t.count++;
        t.totalMs += d;
        t.maxMs = Math.max(t.maxMs, d);
        if (e.type === "tool.completed") t.success++;
        else t.failed++;
        this.toolTimings.set(name, t);
        break;
      }
      case "test.started":
        this.tests.started++;
        break;
      case "test.passed":
        this.tests.passed++;
        break;
      case "test.failed":
        this.tests.failed++;
        break;
    }
  }

  snapshot(): MetricsSnapshot {
    const mem = process.memoryUsage();
    const tools: MetricsSnapshot["tools"] = {};
    for (const [k, v] of this.toolTimings) tools[k] = { ...v, successRate: v.count ? v.success / v.count : 1 };
    const agents: MetricsSnapshot["agents"] = {};
    for (const [k, v] of this.agentTimings) agents[k] = { ...v };
    const total = Object.values(this.counters).reduce((a, b) => a + b, 0);
    return {
      tasks: {
        created: this.counters["task.created"] ?? 0,
        completed: this.counters["task.completed"] ?? 0,
        failed: this.counters["task.failed"] ?? 0,
        cancelled: this.counters["task.cancelled"] ?? 0,
        retries: this.counters["agent.retry"] ?? 0,
        fixes: this.counters["task.fixing"] ?? 0,
        durationMs: { ...this.taskDuration },
      },
      agents,
      tools,
      tests: { ...this.tests, passRate: this.tests.passed + this.tests.failed ? this.tests.passed / (this.tests.passed + this.tests.failed) : 1 },
      events: { total, byType: { ...this.counters } },
      runtime: { uptimeMs: Date.now() - this.startedAt, rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
    };
  }

  toPrometheus(): string {
    const s = this.snapshot();
    const lines: string[] = [];
    const g = (name: string, value: number, labels: Record<string, string> = {}, help?: string) => {
      if (help) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      const l = Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(",");
      lines.push(`${name}${l ? `{${l}}` : ""} ${value}`);
    };
    g("agentos_tasks_total", s.tasks.created, { state: "created" }, "Task counters");
    g("agentos_tasks_total", s.tasks.completed, { state: "completed" });
    g("agentos_tasks_total", s.tasks.failed, { state: "failed" });
    g("agentos_tasks_total", s.tasks.cancelled, { state: "cancelled" });
    g("agentos_task_retries_total", s.tasks.retries, {}, "Retries");
    g("agentos_task_duration_ms_sum", s.tasks.durationMs.totalMs, {}, "Task duration sum");
    g("agentos_task_duration_ms_count", s.tasks.durationMs.count);
    g("agentos_task_duration_ms_max", s.tasks.durationMs.maxMs);
    for (const [tool, v] of Object.entries(s.tools)) {
      g("agentos_tool_calls_total", v.success, { tool, result: "success" });
      g("agentos_tool_calls_total", v.failed, { tool, result: "failed" });
      g("agentos_tool_duration_ms_sum", v.totalMs, { tool });
      g("agentos_tool_success_rate", v.successRate, { tool });
    }
    for (const [role, v] of Object.entries(s.agents)) {
      g("agentos_agent_runs_total", v.count, { role });
      g("agentos_agent_failures_total", v.failures, { role });
      g("agentos_agent_duration_ms_sum", v.totalMs, { role });
    }
    g("agentos_tests_total", s.tests.passed, { result: "passed" }, "Verification runs");
    g("agentos_tests_total", s.tests.failed, { result: "failed" });
    g("agentos_test_pass_rate", s.tests.passRate);
    g("agentos_events_total", s.events.total, {}, "Events emitted");
    g("agentos_uptime_ms", s.runtime.uptimeMs);
    g("agentos_rss_bytes", s.runtime.rssBytes);
    g("agentos_heap_used_bytes", s.runtime.heapUsedBytes);
    return lines.join("\n") + "\n";
  }
}
