import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Skill library (uplift E5): user-authored markdown skills in `<dataDir>/skills/*.md`.
 *
 * A skill is a markdown file with optional frontmatter (`name`, `description`).
 * The harness injects name + description + a capped body excerpt into the agentic
 * system prompt (full bodies stay on disk to protect the context budget — E1).
 *
 * Security scan: skills are user-authored, but they flow into MODEL context, so a
 * hostile or careless skill can act as a prompt injection vector. Files matching
 * the injection/abuse patterns below are REJECTED (not loaded) with a reason —
 * surfaced via `agentos skills list` and the `skills.rejected` event.
 */

export interface Skill {
  name: string;
  description: string;
  file: string;
  /** Capped body used for prompt injection. */
  excerpt: string;
  warnings: string[];
}

export interface SkillsLoadResult {
  skills: Skill[];
  rejected: { file: string; reason: string }[];
}

const MAX_SKILL_BODY_CHARS = 1500;
const MAX_SKILLS_INJECTED = 8;

/** Patterns that make a skill untrustworthy as prompt content. */
const SUSPICIOUS_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba)?sh\b/i, reason: "pipes a download into a shell (remote code execution pattern)" },
  { re: /\brm\s+-rf\s+\/(?:\s|$|\*)/i, reason: "destructive filesystem command" },
  { re: /ignore\s+(all|any|the\s+)?\s*(previous|prior|above)\s+instructions/i, reason: "classic prompt-injection instruction override" },
  { re: /disregard\s+(your|the)\s+(system\s+)?(prompt|instructions|rules)/i, reason: "prompt-instruction override" },
  { re: /you\s+are\s+now\s+(a|an)\s+/i, reason: "persona-hijack pattern" },
  { re: /(reveal|print|repeat|output)\s+(your|the)\s+(system\s+prompt|instructions\s+verbatim)/i, reason: "system-prompt extraction" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "embedded private key material" },
  { re: /\b(sk|gh[pousr]|xox)[a-zA-Z]?-[A-Za-z0-9_-]{16,}/, reason: "secret-shaped token in skill body" },
  { re: /<\|.*?\|>/, reason: "special-token smuggling" },
];

function parseFrontmatter(raw: string): { attrs: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { attrs: {}, body: raw };
  const attrs: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) attrs[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { attrs, body: m[2] };
}

function scan(body: string): string[] {
  return SUSPICIOUS_PATTERNS.filter((p) => p.re.test(body)).map((p) => p.reason);
}

export async function loadSkills(skillsDir: string): Promise<SkillsLoadResult> {
  const result: SkillsLoadResult = { skills: [], rejected: [] };
  let files: string[];
  try {
    files = (await fsp.readdir(skillsDir)).filter((f) => f.toLowerCase().endsWith(".md")).sort();
  } catch {
    return result; // no skills directory yet
  }
  for (const file of files) {
    const full = path.join(skillsDir, file);
    let raw: string;
    try {
      raw = await fsp.readFile(full, "utf8");
    } catch {
      continue;
    }
    const reasons = scan(raw);
    if (reasons.length) {
      result.rejected.push({ file, reason: reasons.join("; ") });
      continue;
    }
    const { attrs, body } = parseFrontmatter(raw);
    const name = (attrs.name || file.replace(/\.md$/i, "")).trim();
    const description = (attrs.description || body.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "").trim();
    result.skills.push({
      name,
      description: description.slice(0, 200),
      file,
      excerpt: body.trim().slice(0, MAX_SKILL_BODY_CHARS) + (body.trim().length > MAX_SKILL_BODY_CHARS ? "…[truncated — read the full skill file if needed]" : ""),
      warnings: [],
    });
    if (result.skills.length >= MAX_SKILLS_INJECTED * 3) break; // generous cap; injection trims further
  }
  return result;
}

/** The system-prompt section injected into agentic runs; null when no skills. */
export function skillsPromptSection(skills: Skill[]): string | null {
  if (!skills.length) return null;
  const lines = skills.slice(0, MAX_SKILLS_INJECTED).map((s) => `### ${s.name}\n${s.description ? `${s.description}\n` : ""}${s.excerpt}`);
  return `Available skills (user-authored playbooks — follow them when they match the goal):\n\n${lines.join("\n\n")}`;
}
