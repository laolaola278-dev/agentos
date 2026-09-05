#!/usr/bin/env node
/* AgentOS command line interface. Run with: npx tsx src/agentos/cli.ts <command> */
import fsp from "node:fs/promises";
import path from "node:path";
import { AgentRuntime, type PersistenceKind } from "./runtime";
import type { Persistence } from "./persistence";
import type { AgentEvent, Task, TaskSpec, TaskStatus } from "./types";
import { TERMINAL_STATUSES } from "./types";
import { redactSecrets } from "./security";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=([\s\S]*)/, 2);
      let v: string | boolean = true;
      if (inline !== undefined) v = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) v = argv[++i];
      if (flags[k] !== undefined) {
        const prev = flags[k];
        flags[k] = Array.isArray(prev) ? [...prev, String(v)] : [String(prev), String(v)];
      } else flags[k] = v;
    } else positional.push(a);
  }
  return { positional, flags };
}

const HELP = `AgentOS — local autonomous agent runtime

Usage: agentos <command> [options]

Commands:
  init                          Initialise .agentos/ in the current directory
  task create                   Create a task (--title, --goal | --spec file.json, --priority, --depends id, --step tool.action:'{json}', --verify cmd, --isolated, --mode plan|agentic)
  task run <id|--spec file>     Run a task in the foreground and stream events (creates it first when --spec/--goal is given)
  task start <id>               Enqueue a task for the daemon / next run
  task status [id]              Show one task or list all (--status FILTER, --json)
  task pause <id>               Pause a running task (checkpointed; works across processes)
  task resume <id>              Resume a paused task from its checkpoint
  task cancel <id>              Cancel a task
  task retry <id>               Retry a failed/cancelled task from scratch
  task logs <id>                Show the event log for a task (--follow, --type prefix, --json)
  task result <id>              Print the structured result (plan, steps, verification, review)
  agent list                    List agent roles
  tools list                    List tools and actions
  events [--task id] [--limit n] Query the global event log
  metrics [--prometheus]        Show runtime metrics
  doctor                        Environment and store diagnostics
  recover [id]                  Resume tasks interrupted by a crash (all, or one)
  daemon                        Run the scheduler loop, executing queued tasks until Ctrl-C
  chat [--auto]                 Interactive session: type goals, watch the agent work (LLM required)
  secrets list|set|get|delete   Encrypted local vault for API keys (.agentos/secrets.json, AES-256-GCM)
  skills list|show <name>       User skills (.agentos/skills/*.md) injected into agentic prompts
  apikeys create|list|revoke    Scoped API keys (SHA-256 hashed) guarding the dashboard API
  eval run|compare              Deterministic eval suites + policy-variant comparison

Global options:
  --root <dir>        Workspace root (default: cwd)
  --data <dir>        Data dir (default: <root>/.agentos)
  --store <kind>      memory | file | sqlite | pg (default: sqlite; env AGENTOS_STORE; pg needs DATABASE_URL)
  --concurrency <n>   Parallel tasks (default 2)
  --shell <path>      Shell for commands (auto-detected; env AGENTOS_SHELL)
  --json              Machine-readable output
  --help, -h          Show help

Extensions (.agentos/config.json):
  hooks               pre_tool_call (exit 2 blocks the tool), post_tool_call, task_completed, task_failed
  mcpServers          MCP servers whose tools join the registry at startup (stdio transport)
`;

/** Loads .env from the root and connects to PostgreSQL (shared with the dashboard). */
async function createPgPersistence(rootDir: string): Promise<Persistence> {
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.join(rootDir, ".env"), quiet: true } as Parameters<typeof dotenv.config>[0]);
  if (!process.env.DATABASE_URL) throw new Error("--store pg requires DATABASE_URL");
  const [{ db }, { PgPersistence }] = await Promise.all([import("@/db"), import("./persistence-pg")]);
  return new PgPersistence(db);
}

function out(obj: unknown, json: boolean, human?: () => string) {
  if (json || !human) console.log(JSON.stringify(redactSecrets(obj), null, 2));
  else console.log(human());
}

function fmtTask(t: Task): string {
  const dur = t.usage.elapsedMs ? `${(t.usage.elapsedMs / 1000).toFixed(1)}s` : "-";
  return `${t.id}  ${t.status.padEnd(10)} p${t.priority}  ${t.spec.title}  [attempt ${t.attempt}, tools ${t.usage.toolCalls}, ${dur}]${t.error ? `\n    error: ${t.error}` : ""}`;
}

function fmtEvent(e: AgentEvent): string {
  const extra = e.error ? ` ✗ ${e.error}` : e.data ? ` ${JSON.stringify(e.data).slice(0, 160)}` : "";
  return `${e.ts}  ${String(e.seq).padStart(5)}  ${(e.agentId ?? "-").padEnd(10).slice(0, 10)}  ${e.type.padEnd(22)}${e.tool ? ` ${e.tool}` : ""}${e.durationMs != null ? ` ${e.durationMs}ms` : ""}${extra}`;
}

async function loadSpec(flags: ParsedArgs["flags"]): Promise<TaskSpec> {
  let spec: Partial<TaskSpec> = {};
  if (typeof flags.spec === "string") spec = JSON.parse(await fsp.readFile(flags.spec, "utf8")) as TaskSpec;
  if (typeof flags.title === "string") spec.title = flags.title;
  if (typeof flags.goal === "string") spec.goal = flags.goal.replace(/\\n/g, "\n");
  if (typeof flags["goal-file"] === "string") spec.goal = await fsp.readFile(flags["goal-file"], "utf8");
  if (typeof flags.mode === "string") {
    if (flags.mode !== "plan" && flags.mode !== "agentic") throw new Error(`invalid --mode "${flags.mode}" (expected "plan" or "agentic")`);
    spec.mode = flags.mode;
  }
  if (flags.priority !== undefined) spec.priority = Number(flags.priority);
  if (flags.depends !== undefined) spec.dependsOn = ([] as string[]).concat(flags.depends as string | string[]);
  if (flags.isolated) spec.isolated = true;
  if (typeof flags.workdir === "string") spec.workdir = flags.workdir;
  if (flags.step !== undefined) {
    const steps = ([] as string[]).concat(flags.step as string | string[]);
    spec.steps = steps.map((s, i) => {
      const m = s.match(/^([a-z_]+)\.([a-z_]+)(?::([\s\S]*))?$/);
      if (!m) throw new Error(`invalid --step "${s}" (expected tool.action:{json})`);
      return { id: `step-${i + 1}`, tool: m[1], action: m[2], args: m[3] ? (JSON.parse(m[3]) as Record<string, unknown>) : {} };
    });
  }
  if (flags.verify !== undefined) {
    spec.verification = ([] as string[]).concat(flags.verify as string | string[]).map((c, i) => ({ name: `verify-${i + 1}`, kind: "custom" as const, command: c }));
  }
  for (const k of ["timeout", "max-retries", "max-tool-calls"] as const) {
    if (flags[k] !== undefined) {
      spec.budget = spec.budget ?? {};
      if (k === "timeout") spec.budget.timeoutMs = Number(flags[k]);
      if (k === "max-retries") spec.budget.maxRetries = Number(flags[k]);
      if (k === "max-tool-calls") spec.budget.maxToolCalls = Number(flags[k]);
    }
  }
  if (!spec.title) spec.title = spec.goal ? spec.goal.split("\n")[0].slice(0, 60) : "untitled";
  if (spec.goal === undefined) spec.goal = "";
  return spec as TaskSpec;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const json = flags.json === true;
  if (flags.help || flags.h || positional.length === 0 || positional[0] === "help") {
    console.log(HELP);
    return 0;
  }
  const rootDir = path.resolve(typeof flags.root === "string" ? flags.root : process.cwd());
  const dataDir = typeof flags.data === "string" ? path.resolve(flags.data) : path.join(rootDir, ".agentos");
  const storeName = typeof flags.store === "string" ? flags.store : process.env.AGENTOS_STORE || "sqlite";
  const store: PersistenceKind | Persistence = storeName === "pg" || storeName === "postgres" ? await createPgPersistence(rootDir) : (storeName as PersistenceKind);
  const [cmd, sub, ...rest] = positional;
  const shell = typeof flags.shell === "string" ? flags.shell : process.env.AGENTOS_SHELL;

  if (cmd === "init") {
    await fsp.mkdir(dataDir, { recursive: true });
    const rt = await AgentRuntime.create({ rootDir, dataDir, persistence: store, controlPollMs: 0, shell });
    const doc = await rt.doctor();
    await rt.close();
    out({ dataDir, store: storeName, doctor: doc }, json, () => `Initialised ${dataDir} (store: ${storeName})\n${doc.checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n")}`);
    return doc.ok ? 0 : 1;
  }

  const rt = await AgentRuntime.create({ rootDir, dataDir, persistence: store, concurrency: flags.concurrency ? Number(flags.concurrency) : undefined, jsonlMirror: true, shell });
  const stop = () => rt.close().then(() => process.exit(130));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    switch (cmd) {
      case "task":
        return await taskCommand(rt, sub, rest, flags, json);
      case "agent":
        out(rt.listAgents(), json, () => rt.listAgents().map((a) => `${a.role.padEnd(11)} ${a.description}`).join("\n"));
        return 0;
      case "tools":
        out(rt.listTools(), json, () => rt.listTools().map((t) => `${t.name} — ${t.description}\n${t.actions.map((a) => `    ${a.name}(${Object.entries(a.params).map(([k, v]) => `${k}: ${v}`).join(", ")}) — ${a.description}`).join("\n")}`).join("\n"));
        return 0;
      case "events": {
        const events = await rt.bus.query({ taskId: typeof flags.task === "string" ? flags.task : undefined, typePrefix: typeof flags.type === "string" ? flags.type : undefined, limit: flags.limit ? Number(flags.limit) : 100 });
        out(events, json, () => events.map(fmtEvent).join("\n") || "(no events)");
        return 0;
      }
      case "metrics":
        if (flags.prometheus) console.log(rt.metrics.toPrometheus());
        else out(rt.metrics.snapshot(), true);
        return 0;
      case "doctor": {
        const doc = await rt.doctor();
        out(doc, json, () => doc.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name.padEnd(12)} ${c.detail}`).join("\n") + `\n${doc.ok ? "All checks passed" : "Some checks failed"}`);
        return doc.ok ? 0 : 1;
      }
      case "recover": {
        if (sub) {
          const r = await rt.recoverTask(sub);
          out(r, json, () => `recovering ${sub} from phase ${r.checkpoint?.phase ?? "(none)"} v${r.checkpoint?.version ?? 0}${r.warnings.length ? `\n  warnings: ${r.warnings.join("; ")}` : ""}`);
          const done = await rt.waitForTask(sub);
          out(done, json, () => fmtTask(done));
          return done.status === "COMPLETED" ? 0 : 1;
        }
        const r = await rt.recoverAll();
        out(r, json, () => (r.recovered.length ? `recovering ${r.recovered.length} task(s): ${r.recovered.join(", ")}` : "nothing to recover"));
        await rt.waitForIdle();
        const tasks = r.recovered.map((id) => rt.getTask(id)!);
        out(tasks, json, () => tasks.map(fmtTask).join("\n"));
        return tasks.every((t) => t.status === "COMPLETED") ? 0 : 1;
      }
      case "chat": {
        const { runChat } = await import("./chat");
        console.error(`agentos chat (store=${storeName}, model=${rt.model?.name ?? "none"})`);
        return await runChat(rt, {
          autoApprove: flags.auto === true,
          maxToolCalls: flags["max-tool-calls"] ? Number(flags["max-tool-calls"]) : undefined,
        });
      }
      case "secrets": {
        const { FileSecretVault, loadMasterKey } = await import("./secrets");
        const vault = rt.secrets ?? new FileSecretVault(dataDir, await loadMasterKey(dataDir));
        const action = sub;
        const name = rest[0];
        const readValue = async (): Promise<string> => {
          if (typeof flags.value === "string") return flags.value;
          const chunks: Buffer[] = [];
          for await (const c of process.stdin) chunks.push(c as Buffer);
          return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
        };
        switch (action) {
          case "list": {
            const names = await vault.list();
            out(names, json, () => (names.length ? names.map((n) => `  ${n}`).join("\n") : "(no secrets stored)"));
            return 0;
          }
          case "set": {
            if (!name) throw new Error("usage: agentos secrets set <NAME> [--value value]  (or pipe the value on stdin)");
            const value = await readValue();
            if (!value.trim()) throw new Error("empty secret value (use --value or pipe stdin)");
            await vault.set(name, value);
            out({ name, stored: true, file: vault.file }, json, () => `stored ${name} in ${vault.file}`);
            return 0;
          }
          case "get": {
            if (!name) throw new Error("usage: agentos secrets get <NAME> [--show]");
            const value = await vault.get(name);
            if (value === null) {
              out({ name, stored: false }, json, () => `${name}: not set`);
              return 1;
            }
            if (flags.show) out({ name, value }, json, () => value);
            else out({ name, stored: true }, json, () => `${name}: set (${value.length} chars, add --show to reveal)`);
            return 0;
          }
          case "delete":
          case "rm": {
            if (!name) throw new Error("usage: agentos secrets delete <NAME>");
            const removed = await vault.delete(name);
            out({ name, removed }, json, () => `${name}: ${removed ? "deleted" : "was not set"}`);
            return removed ? 0 : 1;
          }
          default:
            console.error("usage: agentos secrets list | set <NAME> | get <NAME> [--show] | delete <NAME>");
            return 2;
        }
      }
      case "skills": {
        const { loadSkills } = await import("./skills");
        const res = await loadSkills(path.join(dataDir, "skills"));
        if (sub === "show" && rest[0]) {
          const s = res.skills.find((x) => x.name === rest[0] || x.file === rest[0]);
          if (!s) throw new Error(`no loaded skill "${rest[0]}" (rejected files are not available)`);
          out(s, json, () => `${s.name} (${s.file})\n${s.description}\n\n${s.excerpt}`);
          return 0;
        }
        const lines = [...res.skills.map((s) => `  ${s.name} — ${s.description || "(no description)"} (${s.file})`), ...res.rejected.map((r) => `  ✗ REJECTED ${r.file}: ${r.reason}`)];
        out({ skills: res.skills, rejected: res.rejected }, json, () => lines.join("\n") || "(no skills — add .md files to <dataDir>/skills)");
        return 0;
      }
      case "apikeys": {
        const { ApiKeyStore, API_KEY_SCOPES } = await import("./auth");
        const store = new ApiKeyStore(path.join(dataDir, "apikeys.json"));
        switch (sub) {
          case "create": {
            const name = rest[0];
            if (!name) throw new Error("usage: agentos apikeys create <name> [--scopes tasks:read,tasks:write]");
            const scopes = (typeof flags.scopes === "string" ? flags.scopes.split(",").map((s) => s.trim()).filter(Boolean) : ["tasks:read"]) as ("tasks:read" | "tasks:write" | "admin")[];
            const created = await store.create(name, scopes);
            out({ id: created.id, key: created.key, scopes: created.record.scopes }, json, () => `created ${created.id}\n  key (shown ONCE): ${created.key}\n  scopes: ${created.record.scopes.join(", ")}`);
            return 0;
          }
          case "list": {
            const keys = await store.list();
            out(keys, json, () => keys.map((k) => `  ${k.id}  ${k.name}  [${k.scopes.join(", ")}]${k.revokedAt ? " REVOKED" : ""}`).join("\n") || "(no API keys — auth is disabled until one exists)");
            return 0;
          }
          case "revoke": {
            const id = rest[0];
            if (!id) throw new Error("usage: agentos apikeys revoke <id>");
            const ok = await store.revoke(id);
            out({ id, revoked: ok }, json, () => `${id}: ${ok ? "revoked" : "not found or already revoked"}`);
            return ok ? 0 : 1;
          }
          default:
            console.error(`usage: agentos apikeys create <name> [--scopes ...] | list | revoke <id>\nscopes: ${API_KEY_SCOPES.join(", ")}`);
            return 2;
        }
      }
      case "eval": {
        const { parseEvalSuite, runEvalSuite, saveEvalReport, loadEvalReport, compareReports, getPresetSuite, BUILTIN_EVAL_SUITES } = await import("./evals");
        if (sub === "run") {
          let suite;
          if (typeof flags.preset === "string") suite = getPresetSuite(flags.preset);
          else if (typeof flags.suite === "string") suite = parseEvalSuite(await fsp.readFile(flags.suite, "utf8"));
          else throw new Error(`usage: agentos eval run --suite <file.json> | --preset <${Object.keys(BUILTIN_EVAL_SUITES).join("|")}> --label <name>`);
          const label = typeof flags.label === "string" ? flags.label : `run-${Date.now()}`;
          const report = await runEvalSuite(rt, suite, label);
          const file = await saveEvalReport(path.join(dataDir, "evals"), report);
          out({ ...report, file }, json, () => `eval(${label}) ${report.passed}/${report.total} passed (${(report.passRate * 100).toFixed(0)}%), tokens=${report.tokens}, tools=${report.toolCalls}\n  report: ${file}${report.failed ? "\n" + report.results.filter((r) => !r.passed).map((r) => `  ✗ ${r.id}: ${r.detail}`).join("\n") : ""}`);
          return report.failed ? 1 : 0;
        }
        if (sub === "compare") {
          const [a, b] = rest;
          if (!a || !b) throw new Error("usage: agentos eval compare <base-report.json> <candidate-report.json>");
          const cmp = compareReports(await loadEvalReport(a), await loadEvalReport(b));
          out(cmp, json, () => `${cmp.baseLabel} → ${cmp.candidateLabel}: pass rate ${(cmp.passRateDelta >= 0 ? "+" : "")}${(cmp.passRateDelta * 100).toFixed(0)}pp, tokens ${cmp.tokensDelta >= 0 ? "+" : ""}${cmp.tokensDelta}\n  improvements: ${cmp.improvements.map((i) => i.id).join(", ") || "none"}\n  regressions: ${cmp.regressions.map((r) => r.id).join(", ") || "none"}`);
          return cmp.regressions.length ? 1 : 0;
        }
        console.error("usage: agentos eval run --suite <file> --label <name> | compare <base.json> <candidate.json>");
        return 2;
      }
      case "daemon": {
        const r = await rt.recoverAll();
        if (r.recovered.length) console.error(`recovered ${r.recovered.length} interrupted task(s)`);
        rt.startDaemon(Number(flags.poll ?? 1000));
        rt.bus.subscribe((e) => console.log(fmtEvent(e)), { typePrefix: "task." });
        console.error(`agentos daemon running (store=${storeName}, concurrency=${rt.concurrency}). Ctrl-C to stop.`);
        await new Promise<void>(() => undefined); // until signal
        return 0;
      }
      default:
        console.error(`unknown command: ${cmd}\n`);
        console.log(HELP);
        return 2;
    }
  } finally {
    if (cmd !== "daemon") await rt.close();
  }
}

async function taskCommand(rt: AgentRuntime, sub: string | undefined, rest: string[], flags: ParsedArgs["flags"], json: boolean): Promise<number> {
  const id = rest[0];
  const need = () => {
    if (!id) throw new Error("task id required");
    return id;
  };
  switch (sub) {
    case "create": {
      const t = await rt.createTask(await loadSpec(flags));
      out(t, json, () => `created ${t.id}  (${t.spec.title})`);
      return 0;
    }
    case "run": {
      let taskId = id;
      if (!taskId || flags.spec || flags.goal) taskId = (await rt.createTask(await loadSpec(flags))).id;
      const quiet = flags.quiet === true;
      let inDelta = false;
      const endDelta = () => {
        if (inDelta) {
          process.stdout.write("\n");
          inDelta = false;
        }
      };
      const unsub = rt.bus.subscribe((e) => {
        if (quiet) return;
        if (e.type === "model.delta") {
          // stream the model's text live; transient events are not in the persisted log
          if (json) console.log(JSON.stringify(e));
          else {
            inDelta = true;
            process.stdout.write(String((e.data as { text?: string } | undefined)?.text ?? ""));
          }
          return;
        }
        if (json) console.log(JSON.stringify(e));
        else if (!e.type.startsWith("checkpoint.")) {
          endDelta();
          console.log(fmtEvent(e));
        }
      }, { taskId });
      const task = rt.getTask(taskId)!;
      const done = task.status === "PAUSED" ? (await rt.resumeTask(taskId), await rt.waitForTask(taskId)) : await rt.runTask(taskId);
      unsub();
      endDelta();
      out(done, json, () => `\n${fmtTask(done)}\n${done.result?.summary ?? ""}`);
      return done.status === "COMPLETED" ? 0 : 1;
    }
    case "start": {
      const t = await rt.startTask(need());
      out(t, json, () => `queued ${t.id}`);
      // give the in-process scheduler a chance when run standalone
      await rt.waitForTask(t.id);
      return 0;
    }
    case "status": {
      if (id) {
        const t = await rt.loadTask(id);
        if (!t) throw new Error(`task not found: ${id}`);
        const cp = await rt.persistence.loadCheckpoint(id);
        out({ ...t, checkpoint: cp ? { phase: cp.phase, version: cp.version, progress: cp.progress, steps: cp.completedSteps.length } : null }, json, () => `${fmtTask(t)}${cp ? `\n    checkpoint: phase=${cp.phase} v${cp.version} progress=${cp.progress}% steps=${cp.completedSteps.length}` : ""}`);
        return 0;
      }
      const filter = typeof flags.status === "string" ? (flags.status.toUpperCase().split(",") as TaskStatus[]) : undefined;
      const tasks = rt.listTasks(filter);
      out(tasks, json, () => (tasks.length ? tasks.map(fmtTask).join("\n") : "(no tasks)"));
      return 0;
    }
    case "pause":
    case "cancel": {
      const t = rt.getTask(need());
      if (!t) throw new Error(`task not found: ${id}`);
      if (t.status === "QUEUED" || (sub === "cancel" && !TERMINAL_STATUSES.includes(t.status) && !["PLANNING", "EXECUTING", "VERIFYING", "FIXING", "REVIEWING", "DIAGNOSING", "RETRYING"].includes(t.status))) {
        const r = sub === "pause" ? await rt.pauseTask(id) : await rt.cancelTask(id);
        out(r, json, () => `${sub}d ${r.id} (${r.status})`);
        return 0;
      }
      // running in another process → control file
      await rt.sendControl(id, sub);
      out({ id, command: sub, delivered: "control-file" }, json, () => `${sub} requested for ${id} (delivered via control channel; the running process will checkpoint and stop)`);
      return 0;
    }
    case "resume": {
      const t = await rt.resumeTask(need());
      out(t, json, () => `resuming ${t.id}`);
      const done = await rt.waitForTask(t.id);
      out(done, json, () => fmtTask(done));
      return done.status === "COMPLETED" ? 0 : 1;
    }
    case "retry": {
      await rt.retryTask(need());
      const done = await rt.waitForTask(id);
      out(done, json, () => fmtTask(done));
      return done.status === "COMPLETED" ? 0 : 1;
    }
    case "logs": {
      const typePrefix = typeof flags.type === "string" ? flags.type : undefined;
      const events = await rt.bus.query({ taskId: need(), typePrefix, limit: flags.limit ? Number(flags.limit) : undefined });
      out(events, json, () => events.map(fmtEvent).join("\n") || "(no events)");
      if (flags.follow) {
        let last = events.at(-1)?.id ?? 0;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          const more = await rt.bus.query({ taskId: id, typePrefix, afterId: last });
          for (const e of more) {
            console.log(json ? JSON.stringify(e) : fmtEvent(e));
            last = e.id ?? last;
          }
          const t = await rt.persistence.getTask(id);
          if (t && TERMINAL_STATUSES.includes(t.status) && more.length === 0) break;
        }
      }
      return 0;
    }
    case "result": {
      const t = await rt.loadTask(need());
      if (!t) throw new Error(`task not found: ${id}`);
      out(t.result ?? { error: t.error ?? "no result yet", status: t.status }, true);
      return 0;
    }
    default:
      console.error(`unknown task subcommand: ${sub}`);
      console.log(HELP);
      return 2;
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
