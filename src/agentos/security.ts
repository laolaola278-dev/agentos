import path from "node:path";
import fs from "node:fs";
import { ToolError } from "./types";

const SECRET_KEY_RE = /(secret|token|passw(or)?d|api[_-]?key|authorization|private[_-]?key|credential|cookie|session[_-]?id|database_url|connection[_-]?string)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g, // OpenAI style
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s]+@/gi, // creds in URLs
  /\b(api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*["']?[^\s"'&,;]{6,}/gi,
];

const REDACTED = "[REDACTED]";

function knownSecretValues(): string[] {
  const values: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 8) continue;
    if (SECRET_KEY_RE.test(k)) values.push(v);
  }
  return values;
}

export function redactString(input: string): string {
  let out = input;
  for (const v of knownSecretValues()) {
    if (out.includes(v)) out = out.split(v).join(REDACTED);
  }
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, (m) => {
      // keep the key name for key=value patterns so logs remain useful
      const eq = m.match(/^([A-Za-z_-]+\s*[=:]\s*)/);
      if (eq && !m.startsWith("Bearer")) return `${eq[1]}${REDACTED}`;
      if (/^Bearer/i.test(m)) return `Bearer ${REDACTED}`;
      return REDACTED;
    });
  }
  return out;
}

/** Deep-redacts secrets in any JSON-ish value. Never throws. */
export function redactSecrets<T>(value: T, depth = 0): T {
  try {
    if (depth > 12) return value;
    if (typeof value === "string") return redactString(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1)) as unknown as T;
    if (value && typeof value === "object") {
      if (value instanceof Error) {
        return { name: value.name, message: redactString(value.message) } as unknown as T;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY_RE.test(k) && typeof v === "string" && v.length > 0) out[k] = REDACTED;
        else out[k] = redactSecrets(v, depth + 1);
      }
      return out as T;
    }
    return value;
  } catch {
    return value;
  }
}

const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "USER",
  "NODE_ENV",
  "CI",
  "TZ",
  "COLORTERM",
  "npm_config_cache",
  "XDG_CACHE_HOME",
]);

// Windows exposes its environment in a case-insensitive map and Node commonly
// returns the PATH entry as `Path` rather than `PATH`.  Keep the portable
// allow-list above as the canonical contract, then add only the platform
// variables that are needed to launch a normal child process.  We deliberately
// do not forward the complete parent environment: that would leak credentials
// (and makes task behaviour depend on unrelated shell state).
const WINDOWS_ENV_ALLOWLIST = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "OS",
]);

/**
 * Builds the environment passed to child processes.
 * Only allow-listed variables plus explicitly requested ones (that do not look like secrets) are forwarded.
 */
export function buildSafeEnv(extra: Record<string, string> = {}, allowKeys: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const normalisedAllow = new Set(allowKeys.map((k) => k.toUpperCase()));
  const extraAllow = new Set([
    ...allowKeys,
    ...(process.env.AGENTOS_ALLOW_ENV ? process.env.AGENTOS_ALLOW_ENV.split(",").map((s) => s.trim()) : []),
  ]);
  const extraAllowUpper = new Set([...extraAllow].map((k) => k.toUpperCase()));
  let pathValue: string | undefined;
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    // Preserve an explicit allow-list spelling, but canonicalise Windows'
    // `Path` to `PATH` so callers can rely on a stable key on every OS.
    if (upper === "PATH") {
      pathValue ??= v;
      continue;
    }
    if (ENV_ALLOWLIST.has(k) || ENV_ALLOWLIST.has(upper) || (process.platform === "win32" && WINDOWS_ENV_ALLOWLIST.has(upper)) || normalisedAllow.has(upper) || extraAllowUpper.has(upper)) out[k] = v;
  }
  if (pathValue) out.PATH = pathValue;
  for (const [k, v] of Object.entries(extra)) {
    if (SECRET_KEY_RE.test(k) && !extraAllow.has(k) && !extraAllowUpper.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  // NODE_OPTIONS can inject arbitrary preload modules into a child process;
  // it is intentionally excluded unless the caller explicitly allow-lists it.
  if (extraAllowUpper.has("NODE_OPTIONS") && process.env.NODE_OPTIONS) out.NODE_OPTIONS = process.env.NODE_OPTIONS;
  out.AGENTOS = "1";
  return out;
}

/**
 * Resolve `p` relative to `root` and guarantee the result stays inside `root`,
 * including through symlinks of already-existing ancestors.
 */
export function resolveSafePath(root: string, p: string): string {
  if (typeof p !== "string" || p.length === 0) throw new ToolError("INVALID_PATH", "path must be a non-empty string");
  if (p.includes("\0")) throw new ToolError("INVALID_PATH", "path contains NUL byte");
  const realRoot = safeRealpath(root) ?? path.resolve(root);
  const resolved = path.resolve(realRoot, p);
  const rel = path.relative(realRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolError("PATH_TRAVERSAL", `path escapes workspace: ${p}`);
  }
  // Symlink check: walk up to the nearest existing ancestor and realpath it.
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = safeRealpath(probe);
  if (realProbe) {
    const relReal = path.relative(realRoot, realProbe);
    if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
      throw new ToolError("PATH_TRAVERSAL", `path resolves outside workspace via symlink: ${p}`);
    }
  }
  return resolved;
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|~|\$HOME)(\s|$)/,
  /\bmkfs(\.[a-z0-9]+)?\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd[a-z]/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bchmod\s+(-R\s+)?[0-7]*777\s+\//,
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/,
  /\bwget\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/,
  /\b(?:del|erase|rmdir|rd)\b[^\r\n]*(?:\/s|\/q|--recursive|--quiet)/i,
  /\bformat(?:\.com)?\b/i,
  /\bdiskpart\b/i,
  /\b(?:runas|takeown|icacls)\b[^\r\n]*(?:\/grant|\/f|\/reset)/i,
  /\b(?:remove-item|stop-computer|restart-computer)\b[^\r\n]*(?:-recurse|-force|-confirm:\s*\$?false)?/i,
  /\b(?:curl|wget|invoke-webrequest|iwr)\b[^\r\n]*\|\s*(?:ba)?sh(?:\.exe)?\b/i,
  /\b(?:sudo|doas|su)\s+-?\w/i,
];

/** Rejects clearly destructive commands. Callers may opt out with allowDangerous. */
export function assertCommandAllowed(command: string, allowDangerous = false): void {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new ToolError("INVALID_COMMAND", "command must be a non-empty string");
  }
  if (command.includes("\0")) throw new ToolError("INVALID_COMMAND", "command contains NUL byte");
  if (command.length > 64 * 1024) throw new ToolError("INVALID_COMMAND", "command too long");
  if (/\b(?:powershell|pwsh)\b[^\r\n]*-executionpolicy\s+bypass/i.test(command)) {
    throw new ToolError("DANGEROUS_COMMAND", "command blocked by safety policy: execution-policy bypass");
  }
  if (allowDangerous) return;
  for (const re of DANGEROUS_COMMAND_PATTERNS) {
    if (re.test(command)) {
      throw new ToolError("DANGEROUS_COMMAND", `command blocked by safety policy: ${command.slice(0, 80)}`);
    }
  }
}

/** Validates a git ref / branch name to prevent argument injection (e.g. "--upload-pack"). */
export function assertSafeGitArg(value: string, what = "argument"): void {
  if (typeof value !== "string" || value.length === 0) throw new ToolError("INVALID_ARGUMENT", `${what} is required`);
  if (value.startsWith("-")) throw new ToolError("INVALID_ARGUMENT", `${what} may not start with '-'`);
  if (/[\s\0]/.test(value)) throw new ToolError("INVALID_ARGUMENT", `${what} may not contain whitespace`);
}

const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "100.100.100.200", "metadata", "metadata.internal"]);

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/[\[\]]/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "ip6-localhost") return true;
  if (h === "::1" || h === "0.0.0.0" || h === "::") return true;
  // IPv4 literals, including common integer/hex forms, are checked without a
  // DNS lookup so policy evaluation remains synchronous and deterministic.
  const parts = h.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
    const [a, b] = parts.map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (/^0x[0-9a-f]+$/i.test(h) || /^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) {
      const a = (n >>> 24) & 255;
      const b = (n >>> 16) & 255;
      return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
  }
  return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
}

export function assertUrlAllowed(rawUrl: string, allowedHosts?: string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError("INVALID_URL", `invalid url: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError("INVALID_URL", `unsupported protocol: ${url.protocol}`);
  }
  if (BLOCKED_HOSTS.has(url.hostname.toLowerCase()) || isPrivateHost(url.hostname)) throw new ToolError("BLOCKED_HOST", `host is blocked: ${url.hostname}`);
  if (allowedHosts && allowedHosts.length > 0 && !allowedHosts.includes(url.hostname)) {
    throw new ToolError("BLOCKED_HOST", `host not in allowlist: ${url.hostname}`);
  }
  return url;
}
