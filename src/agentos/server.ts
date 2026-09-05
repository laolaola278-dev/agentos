import "server-only";
import path from "node:path";
import { db } from "@/db";
import { AgentRuntime } from "./runtime";
import { PgPersistence } from "./persistence-pg";

const g = globalThis as typeof globalThis & { __agentosRuntime?: Promise<AgentRuntime> };

/**
 * Process-wide runtime for the Next.js server: PostgreSQL persistence, auto-recovery of
 * interrupted tasks on first use, and daemon polling so tasks created by the CLI (`--store pg`)
 * or the API are picked up.
 */
export function getServerRuntime(): Promise<AgentRuntime> {
  if (!g.__agentosRuntime) {
    g.__agentosRuntime = (async () => {
      const rootDir = process.env.AGENTOS_ROOT ? path.resolve(process.env.AGENTOS_ROOT) : process.cwd();
      const rt = await AgentRuntime.create({
        rootDir,
        dataDir: path.join(rootDir, ".agentos"),
        persistence: new PgPersistence(db),
        concurrency: Number(process.env.AGENTOS_CONCURRENCY ?? 2),
        jsonlMirror: true,
      });
      const recovered = await rt.recoverAll();
      if (recovered.recovered.length) console.log(`[agentos] recovered ${recovered.recovered.length} interrupted task(s)`);
      rt.startDaemon(2000);
      return rt;
    })();
    g.__agentosRuntime.catch(() => {
      g.__agentosRuntime = undefined;
    });
  }
  return g.__agentosRuntime;
}
