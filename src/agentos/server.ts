import "server-only";
import path from "node:path";
import { db } from "@/db";
import { AgentRuntime } from "./runtime";
import { PgPersistence } from "./persistence-pg";
import type { PermissionRequest } from "./types";

const g = globalThis as typeof globalThis & {
  __agentosRuntime?: Promise<AgentRuntime>;
  __agentosApprovals?: WebApprovalBridge;
};

export interface PendingApproval {
  id: string;
  request: PermissionRequest;
  createdAt: string;
  expiresAt: string;
}

export interface WebApprovalBridge {
  pending: Map<string, { approval: PendingApproval; resolve: (ok: boolean) => void }>;
}

/**
 * Wire the runtime's permission gate to the WEB instead of a terminal: every
 * confirm-mode tool call parks in an in-process queue until the dashboard
 * approves/denies it (or the timeout denies fail-closed). One bridge per server.
 */
function installWebApprovalGate(rt: AgentRuntime): WebApprovalBridge {
  if (g.__agentosApprovals) return g.__agentosApprovals;
  const bridge: WebApprovalBridge = { pending: new Map() };
  g.__agentosApprovals = bridge;
  const TIMEOUT_MS = 5 * 60_000;
  rt.tools.setPermissionGate({
    mode: "confirm",
    request: async (req) => {
      const id = `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const approval: PendingApproval = { id, request: req, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TIMEOUT_MS).toISOString() };
      await rt.bus
        .emit({ taskId: req.taskId, agentId: null, type: "approval.requested", data: { approvalId: id, tool: req.tool, action: req.action } })
        .catch(() => undefined);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          bridge.pending.delete(id);
          resolve(false); // fail-closed on timeout
        }, TIMEOUT_MS);
        const settle = (ok: boolean) => {
          clearTimeout(timer);
          const entry = bridge.pending.get(id);
          if (!entry) return resolve(false);
          bridge.pending.delete(id);
          resolve(ok);
        };
        bridge.pending.set(id, { approval, resolve: settle });
      });
    },
  });
  return bridge;
}

export function getApprovalBridge(): Promise<WebApprovalBridge> {
  // returns after the runtime exists (creates it if needed)
  return getServerRuntime().then((rt) => installWebApprovalGate(rt));
}

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
      installWebApprovalGate(rt);
      return rt;
    })();
    g.__agentosRuntime.catch(() => {
      g.__agentosRuntime = undefined;
    });
  }
  return g.__agentosRuntime;
}
