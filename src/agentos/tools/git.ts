import { spawn } from "node:child_process";
import type { GitState, Tool, ToolActionDef, ToolContext, ToolInput } from "../types";
import { ToolError } from "../types";
import { assertSafeGitArg, buildSafeEnv, resolveSafePath, assertUrlAllowed } from "../security";
import { optionalArg, requireArg } from "./registry";

export interface GitRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function normaliseOutput(value: string): string {
  // Git for Windows emits CRLF even when the repository uses LF.  The tool
  // contract is text-oriented, so expose one stable representation to agents,
  // verification and the dashboard.
  return value.replace(/\r\n/g, "\n");
}

/** Runs git without a shell (argument array) so user data can never be interpreted by a shell. */
export function runGit(args: string[], opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number; input?: string }): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    // Disable the user's global autocrlf setting for agent workspaces.  A
    // task's file content and verification evidence should be identical on
    // Windows and POSIX hosts (and should not be silently rewritten on
    // checkout).  `-c` is a git option and remains safe because all user refs
    // are still passed as separate argv entries.
    const gitArgs = process.platform === "win32" ? ["-c", "core.autocrlf=false", "-c", "core.eol=lf", ...args] : args;
    const child = spawn("git", gitArgs, {
      cwd: opts.cwd,
      env: { ...buildSafeEnv(), GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "AgentOS", GIT_AUTHOR_EMAIL: "agentos@local", GIT_COMMITTER_NAME: "AgentOS", GIT_COMMITTER_EMAIL: "agentos@local" } as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30_000);
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.stdin.on("error", () => undefined);
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new ToolError("GIT_UNAVAILABLE", `failed to spawn git: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: code, stdout: normaliseOutput(stdout), stderr: normaliseOutput(stderr) });
    });
  });
}

async function gitOk(args: string[], opts: { cwd: string; signal?: AbortSignal; input?: string }): Promise<string> {
  const r = await runGit(args, opts);
  if (r.exitCode !== 0) {
    throw new ToolError("GIT_ERROR", `git ${args[0]} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`, {
      details: { args, exitCode: r.exitCode, stderr: r.stderr },
    });
  }
  return r.stdout;
}

export async function getGitState(cwd: string, signal?: AbortSignal): Promise<GitState> {
  try {
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd, signal });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return { isRepo: false };
    const head = (await runGit(["rev-parse", "HEAD"], { cwd, signal })).stdout.trim() || undefined;
    const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd, signal })).stdout.trim() || undefined;
    const status = (await runGit(["status", "--porcelain"], { cwd, signal })).stdout;
    return { isRepo: true, head, branch, dirty: status.trim().length > 0 };
  } catch {
    return { isRepo: false };
  }
}

export function parsePorcelain(out: string) {
  return out
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3).trim() }));
}

export class GitTool implements Tool {
  name = "git";
  description = "Safe git operations in the task workdir (no shell, no force-push, no history rewriting)";
  actions: ToolActionDef[] = [
    { name: "status", description: "Working tree status", params: {}, readOnly: true },
    { name: "diff", description: "Diff (optionally staged / against ref / path)", params: { staged: "boolean?", ref: "string?", path: "string?", stat: "boolean?" }, readOnly: true },
    { name: "log", description: "Recent commits", params: { limit: "number?", path: "string?" }, readOnly: true },
    { name: "branch", description: "List or create branch", params: { name: "string?", from: "string?" } },
    { name: "checkout", description: "Checkout branch/ref", params: { ref: "string", create: "boolean?" } },
    { name: "add", description: "Stage paths", params: { paths: "string[]" } },
    { name: "commit", description: "Commit staged changes", params: { message: "string", allowEmpty: "boolean?" } },
    { name: "stash", description: "Stash operations", params: { op: "push|pop|list|drop", message: "string?" } },
    { name: "init", description: "Initialise repository", params: {} },
    { name: "rev_parse", description: "Resolve a ref", params: { ref: "string?" }, readOnly: true },
    { name: "state", description: "Summary: repo, branch, head, dirty", params: {}, readOnly: true },
    { name: "worktree_add", description: "Create an isolated worktree on a new branch", params: { path: "string", branch: "string", from: "string?" } },
    { name: "worktree_remove", description: "Remove a worktree", params: { path: "string", force: "boolean?" } },
    { name: "merge", description: "Merge a branch (no-ff); aborts on conflict", params: { branch: "string", message: "string?" } },
    { name: "branch_delete", description: "Delete a merged branch", params: { name: "string", force: "boolean?" } },
    { name: "clone", description: "Clone a repository into workdir", params: { url: "string", path: "string", depth: "number?" } },
  ];

  async execute(input: ToolInput, ctx: ToolContext): Promise<unknown> {
    const a = input.args ?? {};
    const cwd = ctx.workdir;
    const signal = ctx.signal;
    switch (input.action) {
      case "status": {
        const out = await gitOk(["status", "--porcelain", "--branch"], { cwd, signal });
        const lines = out.split("\n");
        const branchLine = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "";
        return { branch: branchLine, changes: parsePorcelain(lines.slice(1).join("\n")), clean: lines.slice(1).filter((l) => l.trim()).length === 0 };
      }
      case "diff": {
        const args = ["diff", "--no-color"];
        if (optionalArg(a, "staged", false)) args.push("--cached");
        if (optionalArg(a, "stat", false)) args.push("--stat");
        if (a.ref) {
          assertSafeGitArg(String(a.ref), "ref");
          args.push(String(a.ref));
        }
        if (a.path) args.push("--", relPath(ctx, String(a.path)));
        return { diff: await gitOk(args, { cwd, signal }) };
      }
      case "log": {
        const limit = Math.min(Math.max(1, optionalArg(a, "limit", 20)), 500);
        const args = ["log", `-n${limit}`, "--pretty=format:%H%x1f%an%x1f%aI%x1f%s"];
        if (a.path) args.push("--", relPath(ctx, String(a.path)));
        const r = await runGit(args, { cwd, signal });
        if (r.exitCode !== 0) {
          if (/does not have any commits|unknown revision/.test(r.stderr)) return { commits: [] };
          throw new ToolError("GIT_ERROR", r.stderr.trim());
        }
        const commits = r.stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [hash, author, date, subject] = l.split("\x1f");
            return { hash, author, date, subject };
          });
        return { commits };
      }
      case "branch": {
        if (a.name) {
          assertSafeGitArg(String(a.name), "branch name");
          const args = ["branch", String(a.name)];
          if (a.from) {
            assertSafeGitArg(String(a.from), "from");
            args.push(String(a.from));
          }
          await gitOk(args, { cwd, signal });
          return { created: a.name };
        }
        const out = await gitOk(["branch", "--list", "--no-color"], { cwd, signal });
        const branches = out
          .split("\n")
          .filter(Boolean)
          .map((l) => ({ name: l.replace(/^\*?\s+/, "").trim(), current: l.startsWith("*") }));
        return { branches };
      }
      case "checkout": {
        const ref = requireArg<string>(a, "ref");
        assertSafeGitArg(ref, "ref");
        const args = ["checkout"];
        if (optionalArg(a, "create", false)) args.push("-b");
        args.push(ref);
        await gitOk(args, { cwd, signal });
        return { ref, state: await getGitState(cwd, signal) };
      }
      case "add": {
        const paths = requireArg<string[]>(a, "paths", "object");
        if (!Array.isArray(paths) || paths.length === 0) throw new ToolError("INVALID_ARGUMENT", "paths must be a non-empty array");
        const rel = paths.map((p) => relPath(ctx, p));
        await gitOk(["add", "--", ...rel], { cwd, signal });
        return { staged: rel };
      }
      case "commit": {
        const message = requireArg<string>(a, "message");
        if (!message.trim()) throw new ToolError("INVALID_ARGUMENT", "commit message may not be empty");
        const args = ["commit", "-F", "-", "--no-verify"];
        if (optionalArg(a, "allowEmpty", false)) args.push("--allow-empty");
        const r = await runGit(args, { cwd, signal, input: message });
        if (r.exitCode !== 0) {
          if (/nothing to commit|no changes added/.test(r.stdout + r.stderr)) throw new ToolError("NOTHING_TO_COMMIT", "nothing to commit");
          throw new ToolError("GIT_ERROR", (r.stderr || r.stdout).trim());
        }
        const head = (await gitOk(["rev-parse", "HEAD"], { cwd, signal })).trim();
        return { commit: head, message };
      }
      case "stash": {
        const op = optionalArg<string>(a, "op", "push");
        if (op === "push") {
          const args = ["stash", "push", "--include-untracked"];
          if (a.message) args.push("-m", String(a.message));
          const out = await gitOk(args, { cwd, signal });
          return { op, output: out.trim() };
        }
        if (op === "pop") return { op, output: (await gitOk(["stash", "pop"], { cwd, signal })).trim() };
        if (op === "drop") return { op, output: (await gitOk(["stash", "drop"], { cwd, signal })).trim() };
        if (op === "list") return { op, stashes: (await gitOk(["stash", "list"], { cwd, signal })).split("\n").filter(Boolean) };
        throw new ToolError("INVALID_ARGUMENT", `unknown stash op ${op}`);
      }
      case "init": {
        await gitOk(["init", "-q"], { cwd, signal });
        return { initialised: true, state: await getGitState(cwd, signal) };
      }
      case "rev_parse": {
        const ref = optionalArg<string>(a, "ref", "HEAD");
        assertSafeGitArg(ref, "ref");
        return { ref, sha: (await gitOk(["rev-parse", ref], { cwd, signal })).trim() };
      }
      case "state":
        return getGitState(cwd, signal);
      case "worktree_add": {
        const wtPath = requireArg<string>(a, "path");
        const branch = requireArg<string>(a, "branch");
        assertSafeGitArg(branch, "branch");
        const from = optionalArg<string>(a, "from", "HEAD");
        assertSafeGitArg(from, "from");
        const abs = resolveSafePath(ctx.workdir, wtPath);
        await gitOk(["worktree", "add", "-b", branch, abs, from], { cwd, signal });
        return { path: abs, branch };
      }
      case "worktree_remove": {
        const abs = resolveSafePath(ctx.workdir, requireArg<string>(a, "path"));
        const args = ["worktree", "remove"];
        if (optionalArg(a, "force", false)) args.push("--force");
        args.push(abs);
        await gitOk(args, { cwd, signal });
        return { removed: abs };
      }
      case "merge": {
        const branch = requireArg<string>(a, "branch");
        assertSafeGitArg(branch, "branch");
        const args = ["merge", "--no-ff", "--no-edit", "-m", optionalArg(a, "message", `merge ${branch}`), branch];
        const r = await runGit(args, { cwd, signal });
        if (r.exitCode !== 0) {
          const conflicts = parsePorcelain((await runGit(["status", "--porcelain"], { cwd, signal })).stdout).filter((c) => /U|AA|DD/.test(c.status));
          await runGit(["merge", "--abort"], { cwd, signal });
          throw new ToolError("MERGE_CONFLICT", `merge of ${branch} failed and was aborted`, { details: { conflicts, stderr: r.stderr } });
        }
        return { merged: branch, head: (await gitOk(["rev-parse", "HEAD"], { cwd, signal })).trim() };
      }
      case "branch_delete": {
        const name = requireArg<string>(a, "name");
        assertSafeGitArg(name, "branch");
        await gitOk(["branch", optionalArg(a, "force", false) ? "-D" : "-d", name], { cwd, signal });
        return { deleted: name };
      }
      case "clone": {
        const url = requireArg<string>(a, "url");
        assertUrlAllowed(url);
        const dest = resolveSafePath(ctx.workdir, requireArg<string>(a, "path"));
        const args = ["clone", "--quiet"];
        if (a.depth) args.push("--depth", String(Math.max(1, Number(a.depth))));
        args.push("--", url, dest);
        await gitOk(args, { cwd, signal });
        return { path: dest };
      }
      default:
        throw new ToolError("UNKNOWN_ACTION", `unknown git action ${input.action}`);
    }
  }
}

function relPath(ctx: ToolContext, p: string): string {
  return resolveSafePath(ctx.workdir, p);
}
