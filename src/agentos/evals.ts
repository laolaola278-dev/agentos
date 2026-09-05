import fsp from "node:fs/promises";
import path from "node:path";
import type { AcceptanceCheck, Budget, Task, VerificationSpec } from "./types";
import { AgentOSError } from "./types";
import type { AgentRuntime } from "./runtime";
import { nowIso } from "./types";

/**
 * Evaluation + policy-optimization loop (uplift E3, the legitimate transplant of
 * the PAIR-style iterate-and-judge machinery): an eval suite is a set of tasks
 * with objective verifiers; the scorer is deterministic (task status + acceptance
 * evidence + counters — never an LLM's opinion); reports are persisted so two
 * policy variants can be compared mechanically.
 *
 * Usage:
 *   agentos eval run --suite evals.json --label baseline
 *   agentos eval run --suite evals.json --label variant-A   (after a harness change)
 *   agentos eval compare .agentos/evals/baseline-*.json .agentos/evals/variant-A-*.json
 */

export interface EvalCase {
  id: string;
  title: string;
  goal: string;
  steps?: Task["spec"]["steps"];
  acceptance?: AcceptanceCheck[];
  verification?: VerificationSpec[];
  budget?: Partial<Budget>;
  mode?: "plan" | "agentic";
}

export interface EvalSuite {
  name: string;
  cases: EvalCase[];
}

export interface EvalCaseResult {
  id: string;
  title: string;
  passed: boolean;
  status: string;
  tokens: number;
  toolCalls: number;
  elapsedMs: number;
  error?: string;
  detail: string;
}

export interface EvalRunReport {
  label: string;
  suite: string;
  startedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  tokens: number;
  toolCalls: number;
  results: EvalCaseResult[];
}

/**
 * Built-in preset suites (Terminal-Bench-style: every case has objective
 * verifiers, all run offline/deterministically). `agentos eval run --preset core`.
 */
export const BUILTIN_EVAL_SUITES: Record<string, EvalSuite> = {
  core: {
    name: "core",
    cases: [
      { id: "fs-write", title: "atomic file write + existence check", goal: "write ok.txt: preset works\ncheck exists ok.txt" },
      { id: "fs-multi", title: "multi-file write with content checks", goal: "write a.txt: alpha\nwrite b.txt: beta\ncheck contains a.txt: alpha\ncheck not-contains b.txt: alpha" },
      { id: "terminal-redir", title: "shell redirection", goal: "run: echo terminal-ok > t.txt\ncheck contains t.txt: terminal-ok" },
      { id: "terminal-pipe", title: "shell pipeline (sort + head)", goal: "run: printf \"c\\nb\\na\\n\" | sort | head -1 > first.txt\ncheck contains first.txt: a" },
      { id: "verify-cmd", title: "verification command gates completion", goal: "write numbers.txt: 7 13 42\nrun: grep -q 42 numbers.txt\nverify: test -f numbers.txt" },
      { id: "delete-guarded", title: "delete then confirm absence", goal: "write temp.txt: x\ndelete temp.txt\ncheck command: test ! -f temp.txt" },
    ],
  },
};

export function getPresetSuite(name: string): EvalSuite {
  const suite = BUILTIN_EVAL_SUITES[name];
  if (!suite) throw new AgentOSError("EVAL_PRESET_NOT_FOUND", `unknown eval preset "${name}" (available: ${Object.keys(BUILTIN_EVAL_SUITES).join(", ")})`);
  return suite;
}

export function parseEvalSuite(raw: string): EvalSuite {  const parsed = JSON.parse(raw) as EvalSuite;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.cases)) throw new AgentOSError("INVALID_EVAL_SUITE", "eval suite must be an object with a cases array");
  for (const [i, c] of parsed.cases.entries()) {
    if (!c || typeof c !== "object" || !c.id || typeof c.goal !== "string") {
      throw new AgentOSError("INVALID_EVAL_SUITE", `eval case [${i}] requires id and goal`);
    }
  }
  return { name: parsed.name || "suite", cases: parsed.cases };
}

/** Deterministic scorer: objective evidence only (status + acceptance + counters). */
export function scoreCase(caseId: string, result: Task): EvalCaseResult {
  const acceptance = result.result?.acceptance ?? [];
  const acceptancePassed = acceptance.every((a) => a.passed);
  const passed = result.status === "COMPLETED" && acceptancePassed;
  return {
    id: caseId,
    title: result.spec.title,
    passed,
    status: result.status,
    tokens: result.usage.tokens,
    toolCalls: result.usage.toolCalls,
    elapsedMs: result.usage.elapsedMs,
    error: result.error,
    detail: [
      `status=${result.status}`,
      `acceptance=${acceptance.filter((a) => a.passed).length}/${acceptance.length}`,
      ...acceptance.filter((a) => !a.passed).map((a) => `failed: ${a.check.description ?? a.check.type} — ${a.detail}`),
    ].join(" · "),
  };
}

export async function runEvalSuite(rt: AgentRuntime, suite: EvalSuite, label: string): Promise<EvalRunReport> {
  if (!label.trim()) throw new AgentOSError("INVALID_EVAL_LABEL", "eval label is required");
  const startedAt = nowIso();
  const started = Date.now();
  const results: EvalCaseResult[] = [];
  for (const c of suite.cases) {
    const task = await rt.createTask({
      title: `eval(${label}): ${c.title || c.id}`,
      goal: c.goal,
      steps: c.steps,
      acceptance: c.acceptance,
      verification: c.verification,
      budget: c.budget,
      mode: c.mode,
    });
    const done = await rt.runTask(task.id);
    results.push(scoreCase(c.id, done));
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    label,
    suite: suite.name,
    startedAt,
    durationMs: Date.now() - started,
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? passed / results.length : 0,
    tokens: results.reduce((n, r) => n + r.tokens, 0),
    toolCalls: results.reduce((n, r) => n + r.toolCalls, 0),
    results,
  };
}

export interface EvalComparison {
  baseLabel: string;
  candidateLabel: string;
  passRateDelta: number;
  tokensDelta: number;
  regressions: { id: string; title: string; base: string; candidate: string }[];
  improvements: { id: string; title: string; base: string; candidate: string }[];
}

/** Mechanical variant comparison — regressions are named, never guessed. */
export function compareReports(base: EvalRunReport, candidate: EvalRunReport): EvalComparison {
  const byId = (r: EvalRunReport) => new Map(r.results.map((c) => [c.id, c]));
  const b = byId(base);
  const c = byId(candidate);
  const regressions: EvalComparison["regressions"] = [];
  const improvements: EvalComparison["improvements"] = [];
  for (const [id, baseCase] of b) {
    const cand = c.get(id);
    if (!cand) continue;
    if (baseCase.passed && !cand.passed) regressions.push({ id, title: baseCase.title, base: baseCase.status, candidate: cand.status });
    if (!baseCase.passed && cand.passed) improvements.push({ id, title: baseCase.title, base: baseCase.status, candidate: cand.status });
  }
  return {
    baseLabel: base.label,
    candidateLabel: candidate.label,
    passRateDelta: candidate.passRate - base.passRate,
    tokensDelta: candidate.tokens - base.tokens,
    regressions,
    improvements,
  };
}

export async function saveEvalReport(reportsDir: string, report: EvalRunReport): Promise<string> {
  await fsp.mkdir(reportsDir, { recursive: true });
  const file = path.join(reportsDir, `${report.label}-${Date.now()}.json`);
  await fsp.writeFile(file, JSON.stringify(report, null, 2));
  return file;
}

export async function loadEvalReport(file: string): Promise<EvalRunReport> {
  const raw = JSON.parse(await fsp.readFile(file, "utf8")) as EvalRunReport;
  if (!raw || !Array.isArray(raw.results)) throw new AgentOSError("INVALID_EVAL_REPORT", `not an eval report: ${file}`);
  return raw;
}
