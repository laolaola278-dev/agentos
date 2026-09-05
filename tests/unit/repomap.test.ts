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
