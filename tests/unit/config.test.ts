import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { validateAgentOsConfig, loadAgentOsConfig } from "@/agentos/config";
import { tmpDir, rmRetry } from "../helpers";

test("validateAgentOsConfig accepts hooks and mcpServers", () => {
  const cfg = validateAgentOsConfig({
    hooks: {
      pre_tool_call: [{ match: "terminal.*", command: "echo blocked", timeoutMs: 5000 }],
      post_tool_call: [{ command: "node post.js" }],
      task_completed: [{ match: "*", command: "notify.sh" }],
    },
    mcpServers: {
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], env: { TOKEN: "x" }, timeoutMs: 20000 },
    },
  });
  assert.equal(cfg.hooks?.pre_tool_call?.[0].match, "terminal.*");
  assert.equal(cfg.hooks?.pre_tool_call?.[0].timeoutMs, 5000);
  assert.equal(cfg.hooks?.post_tool_call?.[0].match, "*", "match defaults to *");
  assert.equal(cfg.mcpServers?.fs.command, "npx");
  assert.deepEqual(validateAgentOsConfig({}), {});
  assert.deepEqual(validateAgentOsConfig(undefined), {});
});

test("validateAgentOsConfig rejects invalid shapes", () => {
  assert.throws(() => validateAgentOsConfig({ hooks: { bad_event: [] } }), /unknown hook event/);
  assert.throws(() => validateAgentOsConfig({ hooks: { pre_tool_call: [{ command: "x", match: "**" }] } }), /match/);
  assert.throws(() => validateAgentOsConfig({ hooks: { pre_tool_call: [{}] } }), /command/);
  assert.throws(() => validateAgentOsConfig({ hooks: { pre_tool_call: [{ command: "x", timeoutMs: 0 }] } }), /timeoutMs/);
  assert.throws(() => validateAgentOsConfig({ mcpServers: { "bad name!": { command: "x" } } }), /letters, digits/);
  assert.throws(() => validateAgentOsConfig({ mcpServers: { fs: {} } }), /command/);
  assert.throws(() => validateAgentOsConfig({ mcpServers: { fs: { command: "x", args: [1] } } }), /array of strings/);
  assert.throws(() => validateAgentOsConfig([]), /JSON object/);
});

test("loadAgentOsConfig reads dataDir/config.json and reports invalid JSON", async () => {
  const dir = await tmpDir("agentos-config-");
  try {
    assert.equal(await loadAgentOsConfig(dir), null, "missing file → null");
    await fsp.writeFile(path.join(dir, "config.json"), JSON.stringify({ hooks: { task_failed: [{ command: "log.sh" }] } }));
    const cfg = await loadAgentOsConfig(dir);
    assert.equal(cfg?.hooks?.task_failed?.[0].command, "log.sh");
    await fsp.writeFile(path.join(dir, "config.json"), "{not json");
    await assert.rejects(loadAgentOsConfig(dir), (err: Error) => (err as Error & { code?: string }).code === "CONFIG_INVALID");
  } finally {
    await rmRetry(dir);
  }
});
