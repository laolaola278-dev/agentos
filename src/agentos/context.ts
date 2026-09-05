import fsp from "node:fs/promises";
import path from "node:path";
import { Mutex } from "./persistence";

/**
 * Context engineering (uplift E1, the reverse of many-shot flooding / context
 * squeezing): keep the model's working context small and signal-dense.
 *
 * - `cleanToolResult` rewrites tool payloads before they enter the conversation:
 *   long strings keep head+tail, huge arrays keep first/last slices, noisy keys
 *   are dropped. The full payload still goes to the event log / reviewer — this
 *   only shapes what the MODEL sees.
 * - `NotesStore` is an external memory scratchpad (one markdown file per task):
 *   turn summaries survive conversation compaction, so long agentic runs keep a
 *   thread of "what happened" even after old messages are summarized away.
 * - `contextBudgetReport` makes the budget visible instead of guessed.
 */

export interface CleanToolResultOptions {
  /** Max characters for any single string (default 2000). */
  maxStringChars?: number;
  /** Long strings keep headChars + tailChars with an elision marker (default 600/300). */
  headChars?: number;
  tailChars?: number;
  /** Arrays longer than this keep first/last slices (default 40 → 15+10). */
  maxArrayItems?: number;
  /** Object keys dropped entirely (case-insensitive match). */
  stripKeys?: string[];
}

const DEFAULT_STRIP_KEYS = ["stack", "trace", "stderrHead", "stdoutTail", "internal", "rawOutput"];

export interface CleanedToolResult {
  data: unknown;
  /** Characters removed relative to the raw JSON size. */
  removedChars: number;
}

export function cleanToolResult(data: unknown, opts: CleanToolResultOptions = {}): CleanedToolResult {
  const maxStringChars = opts.maxStringChars ?? 2000;
  const headChars = opts.headChars ?? 600;
  const tailChars = opts.tailChars ?? 300;
  const maxArrayItems = opts.maxArrayItems ?? 40;
  const stripKeys = (opts.stripKeys ?? DEFAULT_STRIP_KEYS).map((k) => k.toLowerCase());
  const before = JSON.stringify(data) ?? "";

  const walk = (value: unknown, depth: number, key: string | null): unknown => {
    if (depth > 6) return "[depth-limit]";
    if (key && stripKeys.includes(key.toLowerCase())) return undefined;
    if (typeof value === "string") {
      if (value.length <= maxStringChars) return value;
      const elided = value.length - headChars - tailChars;
      return `${value.slice(0, headChars)}\n…[elided ${elided} chars]…\n${value.slice(-tailChars)}`;
    }
    if (Array.isArray(value)) {
      if (value.length <= maxArrayItems) return value.map((v) => walk(v, depth + 1, null));
      const kept = [...value.slice(0, 15), `…[${value.length - 25} more items]`, ...value.slice(-10)];
      return kept.map((v) => walk(v, depth + 1, null));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const cleaned = walk(v, depth + 1, k);
        if (cleaned !== undefined) out[k] = cleaned;
      }
      return out;
    }
    return value;
  };

  const cleaned = walk(data, 0, null);
  const after = JSON.stringify(cleaned) ?? "";
  return { data: cleaned, removedChars: Math.max(0, before.length - after.length) };
}

/** Append-only external memory: `<artifactsDir>/notes.md`, one timestamped line per append. */
export class NotesStore {
  readonly file: string;
  private mutex = new Mutex();

  constructor(artifactsDir: string) {
    this.file = path.join(artifactsDir, "notes.md");
  }

  async append(line: string): Promise<void> {
    const trimmed = line.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!trimmed) return;
    await this.mutex.run(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.appendFile(this.file, `- [${new Date().toISOString()}] ${trimmed}\n`, "utf8");
    });
  }

  /** Newest-first tail of the notes (oldest entries are compacted away). */
  async read(maxChars = 2000): Promise<string> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, "utf8");
    } catch {
      return "";
    }
    const lines = raw.trimEnd().split("\n");
    const kept: string[] = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0 && total < maxChars; i--) {
      kept.unshift(lines[i]);
      total += lines[i].length + 1;
    }
    if (lines.length > kept.length) kept.unshift(`…[${lines.length - kept.length} earlier notes]`);
    return kept.join("\n");
  }
}

export interface ContextBudgetReport {
  messages: number;
  totalChars: number;
  byRole: Record<string, { count: number; chars: number }>;
  /** Largest message (role + first 120 chars) — the usual compaction candidate. */
  largest: { role: string; chars: number; preview: string } | null;
}

/** Deterministic report of where the conversation budget is going. */
export function contextBudgetReport(messages: { role: string; content: string }[]): ContextBudgetReport {
  const byRole: ContextBudgetReport["byRole"] = {};
  let totalChars = 0;
  let largest: ContextBudgetReport["largest"] = null;
  for (const m of messages) {
    const chars = m.content.length;
    totalChars += chars;
    const slot = (byRole[m.role] ??= { count: 0, chars: 0 });
    slot.count++;
    slot.chars += chars;
    if (!largest || chars > largest.chars) largest = { role: m.role, chars, preview: m.content.slice(0, 120) };
  }
  return { messages: messages.length, totalChars, byRole, largest };
}
