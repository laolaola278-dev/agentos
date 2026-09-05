import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, type RuntimeOptions } from "@/agentos/runtime";
import { runGit } from "@/agentos/tools/git";

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
