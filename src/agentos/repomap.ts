import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Workspace repo-map (uplift: Aider's tree-sitter repo-map, heuristic v1).
 *
 * Walks the workspace (skipping dependency/build dirs), extracts top-level
 * symbol names per source file with per-language line patterns, ranks files by
 * symbol density and renders a compact `path: sym, sym, …` map that fits a
 * character budget. This gives the model a structural index of the project
 * without reading every file.
 *
 * Honest scope: regex-based extraction (no tree-sitter grammar) — it captures
 * the common declarations of TS/JS/Python/Go/Rust and upgrades to a proper
 * parser later without changing the interface.
 */

export interface RepoMapOptions {
  /** Character budget for the rendered map (default 4000). */
  maxChars?: number;
  /** Max files scanned (default 400). */
  maxFiles?: number;
  /** Max directory depth (default 8). */
  maxDepth?: number;
  /** Extra file extensions to include. */
  extensions?: string[];
}

export interface RepoMapResult {
  map: string;
  filesScanned: number;
  symbols: number;
  truncated: boolean;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".agentos", "coverage", "__pycache__", ".venv", "venv", "target", "bin", "obj"]);

const LANG_PATTERNS: { exts: RegExp; patterns: RegExp[] }[] = [
  {
    exts: /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i,
    patterns: [
      /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/g,
      /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/g,
      /(?:^|\n)\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
      /(?:^|\n)\s*export\s+const\s+([A-Za-z0-9_$]+)/g,
    ],
  },
  { exts: /\.py$/i, patterns: [/^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/gm, /^\s*class\s+([A-Za-z0-9_]+)/gm] },
  { exts: /\.go$/i, patterns: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/gm, /^type\s+([A-Za-z0-9_]+)/gm] },
  { exts: /\.rs$/i, patterns: [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/gm, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/gm] },
  { exts: /\.(java|kt|kts)$/i, patterns: [/^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|open\s+|data\s+)*(?:class|interface|object|enum|fun)\s+([A-Za-z0-9_]+)/gm] },
  { exts: /\.(c|cc|cpp|cxx|h|hh|hpp)$/i, patterns: [/^\s*(?:[\w:]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{/gm, /^\s*(?:class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm] },
  { exts: /\.rb$/i, patterns: [/^\s*(?:def|class|module)\s+([A-Za-z0-9_!?]+)/gm] },
];

const DEFAULT_EXT_LIST = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "go", "rs", "java", "kt", "kts", "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "rb"];
const DEFAULT_EXTS = new RegExp(`\\.(${DEFAULT_EXT_LIST.join("|")})$`, "i");

interface FileEntry {
  rel: string;
  symbols: string[];
}

async function walk(dir: string, root: string, depth: number, maxDepth: number, maxFiles: number, accept: RegExp, out: FileEntry[]): Promise<void> {
  if (depth > maxDepth || out.length >= maxFiles) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= maxFiles) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      await walk(full, root, depth + 1, maxDepth, maxFiles, accept, out);
      continue;
    }
    if (!e.isFile() || !accept.test(e.name)) continue;
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    if (stat.size > 512 * 1024) continue;
    let content: string;
    try {
      content = await fsp.readFile(full, "utf8");
    } catch {
      continue;
    }
    const lang = LANG_PATTERNS.find((l) => l.exts.test(e.name));
    // Extra extensions have no grammar of their own; try the JS/TS patterns,
    // and keep the file on the map either way so it is not invisible.
    const patterns = lang?.patterns ?? LANG_PATTERNS[0].patterns;
    const symbols: string[] = [];
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) && symbols.length < 12) {
        if (m[1] && !symbols.includes(m[1])) symbols.push(m[1]);
      }
    }
    if (symbols.length) {
      out.push({ rel: path.relative(root, full).split(path.sep).join("/"), symbols });
    } else if (content.trim()) {
      // a source file with no recognised declaration still belongs on the map
      out.push({ rel: path.relative(root, full).split(path.sep).join("/"), symbols: ["(no declarations)"] });
    }
  }
}

export async function buildRepoMap(workdir: string, opts: RepoMapOptions = {}): Promise<RepoMapResult> {
  const maxChars = opts.maxChars ?? 4000;
  const maxFiles = opts.maxFiles ?? 400;
  const extra = (opts.extensions ?? []).map((ext) => ext.replace(/^\./, "").toLowerCase()).filter((ext) => /^[a-z0-9]+$/.test(ext));
  const accept = extra.length ? new RegExp(`\\.(${[...DEFAULT_EXT_LIST, ...extra].join("|")})$`, "i") : DEFAULT_EXTS;
  const files: FileEntry[] = [];
  await walk(workdir, workdir, 0, opts.maxDepth ?? 8, maxFiles, accept, files);
  // rank: symbol-dense files first, then shallower paths
  files.sort((a, b) => b.symbols.length - a.symbols.length || a.rel.split("/").length - b.rel.split("/").length || a.rel.localeCompare(b.rel));
  const lines: string[] = [];
  let chars = 0;
  let included = 0;
  let truncated = false;
  for (const f of files) {
    const line = `${f.rel}: ${f.symbols.slice(0, 8).join(", ")}${f.symbols.length > 8 ? ", …" : ""}`;
    if (chars + line.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    chars += line.length + 1;
    included++;
  }
  return { map: lines.join("\n"), filesScanned: files.length, symbols: files.reduce((n, f) => n + f.symbols.length, 0), truncated: truncated || files.length > included };
}
