import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, type RuntimeOptions } from "@/agentos/runtime";
import { runGit } from "@/agentos/tools/git";
import type { Message, ModelCompletion, ModelProvider, ModelStreamEvent, ModelToolCompletion, ToolSchema } from "@/agentos/types";

/**
 * Root for all test scratch directories.
 *
 * `os.tmpdir()` resolves to `C:\Users\<user>\AppData\Local\Temp` on Windows,
 * which breaks the standing rule that scratch data must never land on the
 * system drive. Tests therefore honour an explicit override:
 *   AGENTOS_TEST_TMP  (preferred)
 *   TMPDIR / TEMP     (fallback)
 * and only fall back to os.tmpdir() when none is set.
 */
export function testTmpRoot(): string {
  const override = process.env.AGENTOS_TEST_TMP || process.env.TMPDIR || process.env.TEMP;
  if (override && override.trim()) return path.resolve(override.trim());
  return os.tmpdir();
}

export async function tmpDir(prefix = "agentos-test-"): Promise<string> {
  const root = testTmpRoot();
  await fsp.mkdir(root, { recursive: true });
  return fsp.mkdtemp(path.join(root, prefix));
}

export async function makeRuntime(opts: RuntimeOptions & { git?: boolean } = {}): Promise<{ rt: AgentRuntime; dir: string; cleanup: () => Promise<void> }> {
  const dir = await tmpDir();
  if (opts.git) {
    await runGit(["init", "-q", "-b", "main"], { cwd: dir });
    await fsp.writeFile(path.join(dir, "README.md"), "# test\n");
    await runGit(["add", "-A"], { cwd: dir });
    await runGit(["commit", "-q", "-m", "init"], { cwd: dir });
  }
  const rt = await AgentRuntime.create({ rootDir: dir, dataDir: path.join(dir, ".agentos"), persistence: "memory", model: null, controlPollMs: 0, ...opts });
  return {
    rt,
    dir,
    cleanup: async () => {
      await rt.close();
      // Windows keeps a deleted tree locked while child processes still hold it
      // as their cwd; a bare rm races and fails with EBUSY.
      await rmRetry(dir);
    },
  };
}

export const NO_LLM = { model: null } as const;

// ---- mocked model provider (LLM-driven planner / agentic loop tests) ----

export interface MockModelProviderOptions {
  /** Text completion response (planner / reviewer / debugger prompts). */
  completeResponse?: string;
  /** Scripted tool-calling turns, consumed in order; the last one repeats when exhausted. */
  turns?: ModelToolCompletion[];
  /** Dynamic per-turn response (overrides `turns`). */
  onTools?: (turn: number, messages: Message[], tools: ToolSchema[]) => ModelToolCompletion;
}

/** Scripted provider exercising the harness without network access. */
export class MockModelProvider implements ModelProvider {
  name = "mock:scripted";
  turnCount = 0;
  completeCount = 0;
  streamCount = 0;
  quirks?: { toolStreaming?: boolean; jsonMode?: boolean; maxTokens?: number };
  constructor(private opts: MockModelProviderOptions) {}

  async complete(messages: Message[]): Promise<ModelCompletion> {
    this.completeCount++;
    void messages;
    const content = this.opts.completeResponse ?? '{"issues":[]}';
    return { content, tokens: Math.ceil(content.length / 4) };
  }

  async completeWithTools(messages: Message[], tools: ToolSchema[]): Promise<ModelToolCompletion> {
    this.turnCount++;
    if (this.opts.onTools) return this.opts.onTools(this.turnCount, messages, tools);
    const turns = this.opts.turns ?? [{ content: "done", toolCalls: [], tokens: 1 }];
    const turn = turns[Math.min(this.turnCount - 1, turns.length - 1)];
    return { content: turn.content, toolCalls: turn.toolCalls, tokens: turn.tokens, finishReason: turn.finishReason };
  }

  async *stream(messages: Message[], opts: { tools?: ToolSchema[] } = {}): AsyncGenerator<ModelStreamEvent> {
    this.streamCount++;
    // exercise the same scripted turns as completeWithTools so the agentic
    // streaming path is covered without network access
    if (!opts.tools?.length) {
      const { content } = await this.complete(messages);
      for (const part of content.match(/[\s\S]{1,8}/g) ?? []) yield { delta: part };
      yield { completion: { content, tokens: Math.ceil(content.length / 4), toolCalls: [] } };
      return;
    }
    const completion = await this.completeWithTools(messages, opts.tools);
    if (completion.content) for (const part of completion.content.match(/[\s\S]{1,8}/g) ?? []) yield { delta: part };
    yield { completion };
  }
}

export function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2, 8)}`): { id: string; name: string; arguments: string } {
  return { id, name, arguments: JSON.stringify(args ?? {}) };
}

/** Windows can briefly hold a deleted tree while child processes release their cwd. */
export async function rmRetry(dir: string, attempts = 8): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
