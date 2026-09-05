import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, type RuntimeOptions } from "@/agentos/runtime";
import { runGit } from "@/agentos/tools/git";
import type { Message, ModelCompletion, ModelProvider, ModelStreamEvent, ModelToolCompletion, ToolSchema } from "@/agentos/types";

export async function tmpDir(prefix = "agentos-test-"): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
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
      await fsp.rm(dir, { recursive: true, force: true });
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

  async *stream(messages: Message[]): AsyncGenerator<ModelStreamEvent> {
    const { content } = await this.complete(messages);
    for (const part of content.match(/[\s\S]{1,8}/g) ?? []) yield { delta: part };
    yield { completion: { content, tokens: Math.ceil(content.length / 4), toolCalls: [] } };
  }
}

export function toolCall(name: string, args: unknown, id = `call_${Math.random().toString(36).slice(2, 8)}`): { id: string; name: string; arguments: string } {
  return { id, name, arguments: JSON.stringify(args ?? {}) };
}
