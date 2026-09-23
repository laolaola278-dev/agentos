import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { buildRepoMap } from "@/agentos/repomap";
import { tmpDir } from "../helpers";

test("repo-map extracts symbols per language and skips dependency dirs", async () => {
  const dir = await tmpDir("agentos-repomap-");
  try {
    await fsp.mkdir(path.join(dir, "src", "nested"), { recursive: true });
    await fsp.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await fsp.writeFile(
      path.join(dir, "src", "service.ts"),
      "export class UserService {}\nexport async function createUser() {}\nexport interface Role {}\nconst hidden = 1;\n",
    );
    await fsp.writeFile(path.join(dir, "src", "nested", "util.ts"), "export function formatDate() {}\nexport type Mode = 'a' | 'b';\n");
    await fsp.writeFile(path.join(dir, "app.py"), "class App:\n    pass\n\ndef run_app():\n    pass\n");
    await fsp.writeFile(path.join(dir, "main.go"), "func main() {}\nfunc (s *Server) Start() {}\n");
    await fsp.writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "function shouldNotAppear() {}\n");

    const { map, filesScanned, symbols, truncated } = await buildRepoMap(dir, { maxChars: 4000 });
    assert.match(map, /src\/service\.ts: UserService, createUser, Role/);
    assert.match(map, /src\/nested\/util\.ts: formatDate, Mode/);
    assert.match(map, /app\.py: (App, run_app|run_app, App)/);
    assert.match(map, /main\.go: (main|Start)/);
    assert.ok(!map.includes("shouldNotAppear"), "node_modules skipped");
    assert.equal(filesScanned, 4);
    assert.ok(symbols >= 7);
    assert.equal(truncated, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("repo-map keeps files without declarations and honours extra extensions", async () => {
  const dir = await tmpDir("agentos-repomap3-");
  try {
    await fsp.writeFile(path.join(dir, "config.ts"), "const value = 1;\n");
    await fsp.writeFile(path.join(dir, "Widget.java"), "public class Widget {}\n");
    await fsp.writeFile(path.join(dir, "notes.xyz"), "export function fromXyz() {}\n");
    const { map } = await buildRepoMap(dir, { extensions: [".xyz"], maxChars: 4000 });
    assert.match(map, /config\.ts: \(no declarations\)/);
    assert.match(map, /Widget\.java: Widget/);
    assert.match(map, /notes\.xyz: fromXyz/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("repo-map respects the character budget and flags truncation", async () => {
  const dir = await tmpDir("agentos-repomap2-");
  try {
    for (let i = 0; i < 30; i++) {
      await fsp.writeFile(path.join(dir, `mod${i}.ts`), `export function fn${i}() {}\nexport function extra${i}() {}\n`);
    }
    const { map, truncated } = await buildRepoMap(dir, { maxChars: 400 });
    assert.ok(map.length <= 400 + 200, `map bounded (${map.length})`);
    assert.equal(truncated, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("readProjectInstructions walks parent directories, nearest first", async () => {
  const { readProjectInstructions } = await import("@/agentos/agents");
  const dir = await tmpDir("agentos-hier-");
  try {
    await fsp.mkdir(path.join(dir, "packages", "app"), { recursive: true });
    await fsp.writeFile(path.join(dir, "AGENTS.md"), "# Root rules\n- use pnpm at the root");
    await fsp.writeFile(path.join(dir, "packages", "app", "AGENTS.md"), "# App rules\n- app deploys first");
    const text = (await readProjectInstructions(path.join(dir, "packages", "app"))) ?? "";
    // nearest directory wins (appears first), parent appended as context
    const appIdx = text.indexOf("App rules");
    const rootIdx = text.indexOf("Root rules");
    assert.ok(appIdx >= 0 && rootIdx >= 0, `both sections present: ${text}`);
    assert.ok(appIdx < rootIdx, "nearest directory takes precedence");
    assert.match(text, /parent directory/, "parent section labelled");
    // walking up from a subdirectory still finds the root AGENTS.md
    const fromSub = (await readProjectInstructions(path.join(dir, "packages"))) ?? "";
    assert.match(fromSub, /Root rules/);
    // a fresh tree with no instructions anywhere up the chain → null
    const empty = await tmpDir("agentos-hier-empty-");
    try {
      assert.equal(await readProjectInstructions(empty), null);
    } finally {
      await fsp.rm(empty, { recursive: true, force: true });
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
