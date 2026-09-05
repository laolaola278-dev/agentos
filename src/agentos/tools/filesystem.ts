import fsp from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolActionDef, ToolContext, ToolInput } from "../types";
import { ToolError } from "../types";
import { resolveSafePath } from "../security";
import { atomicWriteFile, Mutex } from "../persistence";
import { optionalArg, requireArg } from "./registry";

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", ".agentos"]);
const appendLocks = new Map<string, Mutex>();

function appendMutex(file: string): Mutex {
  let mutex = appendLocks.get(file);
  if (!mutex) {
    mutex = new Mutex();
    appendLocks.set(file, mutex);
  }
  return mutex;
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function mapFsError(err: unknown, p: string): never {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") throw new ToolError("NOT_FOUND", `no such file or directory: ${p}`);
  if (e?.code === "EACCES" || e?.code === "EPERM") throw new ToolError("PERMISSION_DENIED", `permission denied: ${p}`);
  if (e?.code === "EISDIR") throw new ToolError("IS_DIRECTORY", `is a directory: ${p}`);
  if (e?.code === "ENOTDIR") throw new ToolError("NOT_DIRECTORY", `not a directory: ${p}`);
  if (e?.code === "EEXIST") throw new ToolError("ALREADY_EXISTS", `already exists: ${p}`);
  if (e?.code === "EBUSY") throw new ToolError("BUSY", `resource busy: ${p}`, { retryable: true });
  throw err;
}

export class FilesystemTool implements Tool {
  name = "filesystem";
  description = "Sandboxed filesystem access limited to the task workdir";
  actions: ToolActionDef[] = [
    { name: "read", description: "Read a text file (optionally a line range)", params: { path: "string", maxBytes: "number?", encoding: "utf8|base64?", startLine: "number?", endLine: "number?" } },
    { name: "write", description: "Write a file atomically (creates parents)", params: { path: "string", content: "string" } },
    { name: "append", description: "Append to a file atomically", params: { path: "string", content: "string" } },
    { name: "edit", description: "Replace text in a file", params: { path: "string", oldText: "string", newText: "string", all: "boolean?" } },
    { name: "apply_patch", description: "Apply a unified or OpenAI-style patch atomically", params: { patch: "string" } },
    { name: "patch", description: "Alias for apply_patch", params: { patch: "string" } },
    { name: "delete", description: "Delete a file or directory", params: { path: "string", recursive: "boolean?" } },
    { name: "move", description: "Move/rename", params: { from: "string", to: "string" } },
    { name: "copy", description: "Copy file or directory", params: { from: "string", to: "string" } },
    { name: "list", description: "List directory entries", params: { path: "string?", recursive: "boolean?", maxEntries: "number?" } },
    { name: "search", description: "Regex search across files", params: { pattern: "string", path: "string?", glob: "string?", maxResults: "number?" } },
    { name: "mkdir", description: "Create directory", params: { path: "string" } },
    { name: "stat", description: "File metadata", params: { path: "string" } },
    { name: "exists", description: "Check existence", params: { path: "string" } },
  ];

  async execute(input: ToolInput, ctx: ToolContext): Promise<unknown> {
    const a = input.args ?? {};
    const safe = (p: string) => resolveSafePath(ctx.workdir, p);
    switch (input.action) {
      case "read":
        return this.read(
          safe(requireArg(a, "path")),
          optionalArg(a, "maxBytes", DEFAULT_MAX_READ_BYTES),
          optionalArg(a, "encoding", "utf8"),
          optionalArg<number | undefined>(a, "startLine", undefined),
          optionalArg<number | undefined>(a, "endLine", undefined),
        );
      case "write": {
        const p = safe(requireArg(a, "path"));
        const content = requireArg<string>(a, "content");
        try {
          await atomicWriteFile(p, content);
        } catch (err) {
          mapFsError(err, p);
        }
        return { path: p, bytes: Buffer.byteLength(content) };
      }
      case "append": {
        const p = safe(requireArg(a, "path"));
        const content = requireArg<string>(a, "content");
        try {
          await appendMutex(path.resolve(p)).run(async () => {
            await fsp.mkdir(path.dirname(p), { recursive: true });
            let previous = "";
            try {
              previous = await fsp.readFile(p, "utf8");
            } catch (err) {
              if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
            }
            await atomicWriteFile(p, previous + content);
          });
        } catch (err) {
          mapFsError(err, p);
        }
        return { path: p, bytes: Buffer.byteLength(content) };
      }
      case "edit": {
        const p = safe(requireArg(a, "path"));
        const oldText = requireArg<string>(a, "oldText");
        const newText = requireArg<string>(a, "newText");
        const all = optionalArg(a, "all", false);
        let text: string;
        try {
          text = await fsp.readFile(p, "utf8");
        } catch (err) {
          mapFsError(err, p);
        }
        const count = text!.split(oldText).length - 1;
        if (count === 0) throw new ToolError("EDIT_NO_MATCH", `oldText not found in ${p}`);
        if (count > 1 && !all) throw new ToolError("EDIT_AMBIGUOUS", `oldText matches ${count} times in ${p}; pass all=true`);
        const updated = all ? text!.split(oldText).join(newText) : text!.replace(oldText, () => newText);
        await atomicWriteFile(p, updated);
        return { path: p, replacements: all ? count : 1 };
      }
      case "apply_patch":
      case "patch": {
        const patchText = requireArg<string>(a, "patch");
        return this.applyPatch(patchText, ctx);
      }
      case "delete": {
        const p = safe(requireArg(a, "path"));
        if (path.resolve(p) === path.resolve(ctx.workdir)) throw new ToolError("REFUSED", "refusing to delete the workdir root");
        try {
          const st = await fsp.lstat(p);
          if (st.isDirectory() && !optionalArg(a, "recursive", false)) throw new ToolError("IS_DIRECTORY", `pass recursive=true to delete directory ${p}`);
          await fsp.rm(p, { recursive: st.isDirectory(), force: false });
        } catch (err) {
          if (err instanceof ToolError) throw err;
          mapFsError(err, p);
        }
        return { path: p, deleted: true };
      }
      case "move": {
        const from = safe(requireArg(a, "from"));
        const to = safe(requireArg(a, "to"));
        try {
          await fsp.mkdir(path.dirname(to), { recursive: true });
          await fsp.rename(from, to);
        } catch (err) {
          mapFsError(err, from);
        }
        return { from, to };
      }
      case "copy": {
        const from = safe(requireArg(a, "from"));
        const to = safe(requireArg(a, "to"));
        try {
          await fsp.mkdir(path.dirname(to), { recursive: true });
          await fsp.cp(from, to, { recursive: true, errorOnExist: false });
        } catch (err) {
          mapFsError(err, from);
        }
        return { from, to };
      }
      case "list":
        return this.list(safe(optionalArg(a, "path", ".")), optionalArg(a, "recursive", false), optionalArg(a, "maxEntries", 2000), ctx);
      case "search":
        return this.search(
          safe(optionalArg(a, "path", ".")),
          requireArg(a, "pattern"),
          optionalArg<string | undefined>(a, "glob", undefined),
          optionalArg(a, "maxResults", 200),
          ctx,
        );
      case "mkdir": {
        const p = safe(requireArg(a, "path"));
        await fsp.mkdir(p, { recursive: true });
        return { path: p };
      }
      case "stat": {
        const p = safe(requireArg(a, "path"));
        try {
          const st = await fsp.stat(p);
          return { path: p, size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory(), mtime: st.mtime.toISOString(), mode: st.mode };
        } catch (err) {
          mapFsError(err, p);
        }
        break;
      }
      case "exists": {
        const p = safe(requireArg(a, "path"));
        try {
          await fsp.access(p);
          return { path: p, exists: true };
        } catch {
          return { path: p, exists: false };
        }
      }
      default:
        throw new ToolError("UNKNOWN_ACTION", `unknown filesystem action ${input.action}`);
    }
  }

  private async read(p: string, maxBytes: number, encoding: string, startLine?: number, endLine?: number) {
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(p, "r");
    } catch (err) {
      mapFsError(err, p);
    }
    try {
      const st = await handle!.stat();
      if (st.isDirectory()) throw new ToolError("IS_DIRECTORY", `is a directory: ${p}`);
      const toRead = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(toRead);
      await handle!.read(buf, 0, toRead, 0);
      const binary = isBinary(buf);
      if (binary && encoding !== "base64") {
        return { path: p, binary: true, size: st.size, content: null, note: "binary file; request encoding=base64 to read" };
      }
      let content = encoding === "base64" ? buf.toString("base64") : buf.toString("utf8");
      if (!binary && encoding !== "base64" && (startLine !== undefined || endLine !== undefined)) {
        const start = Number.isInteger(startLine) && startLine! >= 1 ? startLine! : 1;
        const end = Number.isInteger(endLine) && endLine! >= start ? endLine! : Number.MAX_SAFE_INTEGER;
        content = content.split(/\r?\n/).slice(start - 1, end).join("\n");
      }
      return {
        path: p,
        size: st.size,
        binary,
        truncated: st.size > maxBytes,
        content,
      };
    } finally {
      await handle!.close();
    }
  }

  private async applyPatch(patchText: string, ctx: ToolContext) {
    const files = parsePatch(patchText);
    if (files.length === 0) throw new ToolError("INVALID_ARGUMENT", "patch contains no file changes");
    let additions = 0;
    let deletions = 0;
    const changed: string[] = [];
    for (const file of files) {
      if (!file.path) throw new ToolError("INVALID_ARGUMENT", "patch file path is missing");
      const p = resolveSafePath(ctx.workdir, file.path);
      if (/(^|[\\/])(?:\.git|node_modules)(?:[\\/]|$)/i.test(path.relative(ctx.workdir, p))) throw new ToolError("PROTECTED_PATH", `refusing to patch protected path: ${file.path}`);
      if (file.kind === "delete") {
        try {
          await fsp.rm(p, { force: false });
        } catch (err) {
          mapFsError(err, p);
        }
        changed.push(file.path);
        continue;
      }
      let original = "";
      try {
        original = await fsp.readFile(p, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT" || file.kind === "update") mapFsError(err, p);
      }
      const hadFinalNewline = original.endsWith("\n");
      let next: string;
      if (file.kind === "add") {
        next = (file.lines ?? []).join("\n");
      } else {
        const applied = applyHunks(original.replace(/\r\n/g, "\n").split("\n"), file.hunks ?? []);
        next = applied.lines.join("\n");
        additions += applied.additions;
        deletions += applied.deletions;
      }
      if (file.kind === "add") additions += next ? next.split("\n").length : 0;
      if (hadFinalNewline || file.kind === "add") next = next.replace(/\n?$/, "\n");
      await atomicWriteFile(p, next);
      changed.push(file.path);
    }
    return { files: changed, additions, deletions };
  }

  private async list(dir: string, recursive: boolean, maxEntries: number, ctx: ToolContext) {
    const entries: { path: string; type: "file" | "dir" | "symlink" | "other"; size?: number }[] = [];
    let truncated = false;
    const walk = async (d: string): Promise<void> => {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      let dirents;
      try {
        dirents = await fsp.readdir(d, { withFileTypes: true });
      } catch (err) {
        mapFsError(err, d);
      }
      for (const de of dirents!) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        const full = path.join(d, de.name);
        const rel = path.relative(ctx.workdir, full) || ".";
        const type = de.isDirectory() ? "dir" : de.isFile() ? "file" : de.isSymbolicLink() ? "symlink" : "other";
        let size: number | undefined;
        if (type === "file") {
          try {
            size = (await fsp.stat(full)).size;
          } catch {
            size = undefined;
          }
        }
          entries.push({ path: rel, type, size });
        if (recursive && type === "dir" && !IGNORED_DIRS.has(de.name)) await walk(full);
      }
    };
    await walk(dir);
    return { entries, truncated };
  }

  private async search(dir: string, pattern: string, glob: string | undefined, maxResults: number, ctx: ToolContext) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      throw new ToolError("INVALID_ARGUMENT", `invalid regex: ${pattern}`);
    }
    const globRe = glob ? globToRegExp(glob) : null;
    const matches: { file: string; line: number; text: string }[] = [];
    let filesScanned = 0;
    const walk = async (d: string): Promise<void> => {
      if (matches.length >= maxResults) return;
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const dirents = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
      for (const de of dirents) {
        const full = path.join(d, de.name);
        if (de.isDirectory()) {
          if (!IGNORED_DIRS.has(de.name)) await walk(full);
        } else if (de.isFile()) {
          const rel = path.relative(ctx.workdir, full).split(path.sep).join("/");
          if (globRe && !globRe.test(rel) && !globRe.test(de.name)) continue;
          let buf: Buffer;
          try {
            buf = await fsp.readFile(full);
          } catch {
            continue;
          }
          if (buf.length > 4 * 1024 * 1024 || isBinary(buf)) continue;
          filesScanned++;
          const lines = buf.toString("utf8").split("\n");
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i])) {
              matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 500) });
              if (matches.length >= maxResults) return;
            }
          }
        }
      }
    };
    await walk(dir);
    return { matches, filesScanned, truncated: matches.length >= maxResults };
  }
}

interface ParsedHunk {
  oldStart: number;
  lines: string[];
}

interface ParsedPatchFile {
  path: string;
  kind: "update" | "add" | "delete";
  lines?: string[];
  hunks?: ParsedHunk[];
}

/** Parse the compact patch dialect emitted by common coding agents as well as unified diff. */
function parsePatch(raw: string): ParsedPatchFile[] {
  if (raw.length > 8 * 1024 * 1024) throw new ToolError("INVALID_ARGUMENT", "patch is too large (max 8 MiB)");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const out: ParsedPatchFile[] = [];
  let current: ParsedPatchFile | undefined;
  let hunk: ParsedHunk | undefined;
  const normalPath = (p: string) => p.trim().replace(/^([ab])\//, "");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "*** Begin Patch" || line === "*** End Patch" || line === "*** End of File") continue;
    let m = line.match(/^\*\*\*\s+(Update|Add|Delete) File:\s*(.+)$/);
    if (m) {
      current = { path: m[2].trim(), kind: m[1].toLowerCase() as ParsedPatchFile["kind"], ...(m[1] === "Add" ? { lines: [] } : {}) };
      out.push(current);
      hunk = undefined;
      continue;
    }
    if (line.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      const oldPath = normalPath(line.slice(4).split("\t")[0]);
      const newPath = normalPath(lines[++i].slice(4).split("\t")[0]);
      const kind = oldPath === "/dev/null" ? "add" : newPath === "/dev/null" ? "delete" : "update";
      current = { path: kind === "delete" ? oldPath : newPath, kind, ...(kind === "add" ? { lines: [] } : {}) };
      out.push(current);
      hunk = undefined;
      continue;
    }
    m = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/);
    if (m && current) {
      hunk = { oldStart: Number(m[1]), lines: [] };
      (current.hunks ??= []).push(hunk);
      continue;
    }
    if (!current) continue;
    if (current.kind === "add" && current.lines) {
      if (line.startsWith("+")) current.lines.push(line.slice(1));
      else if (line === "\\ No newline at end of file") continue;
      continue;
    }
    if (hunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line === "\\ No newline at end of file")) {
      if (line !== "\\ No newline at end of file") hunk.lines.push(line);
    }
  }
  return out.filter((f) => f.path && (f.kind !== "update" || (f.hunks?.length ?? 0) > 0));
}

function applyHunks(source: string[], hunks: ParsedHunk[]): { lines: string[]; additions: number; deletions: number } {
  let lines = [...source];
  let offset = 0;
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    const oldLines = h.lines.filter((l) => l.startsWith(" ") || l.startsWith("-")).map((l) => l.slice(1));
    const newLines = h.lines.filter((l) => l.startsWith(" ") || l.startsWith("+")).map((l) => l.slice(1));
    let at = Math.max(0, Math.min(lines.length, h.oldStart - 1 + offset));
    const matches = (index: number) => oldLines.every((line, i) => lines[index + i] === line);
    if (!matches(at)) {
      // Permit a small context drift, as git apply does when nearby lines were
      // added by another step, while still requiring exact context content.
      const candidates: number[] = [];
      for (let i = 0; i <= lines.length - oldLines.length; i++) if (matches(i)) candidates.push(i);
      if (candidates.length !== 1) throw new ToolError("PATCH_FAILED", `patch hunk could not be applied at line ${h.oldStart}`);
      at = candidates[0];
    }
    lines.splice(at, oldLines.length, ...newLines);
    offset += newLines.length - oldLines.length;
    additions += h.lines.filter((l) => l.startsWith("+")).length;
    deletions += h.lines.filter((l) => l.startsWith("-")).length;
  }
  return { lines, additions, deletions };
}

export function globToRegExp(glob: string): RegExp {
  glob = glob.replace(/\\/g, "/");
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}
