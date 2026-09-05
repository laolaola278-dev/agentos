import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { PROVIDER_PROFILES, resolveProviderSettings, createProviderFromSettings } from "@/agentos/providers";
import { repairToolArguments, balanceJson } from "@/agentos/model";
import { validateAgentOsConfig } from "@/agentos/config";
import { FileSecretVault, loadMasterKey } from "@/agentos/secrets";
import { tmpDir } from "../helpers";

test("provider profiles: github-models points at the hosted gateway with GITHUB_TOKEN", () => {
  assert.equal(PROVIDER_PROFILES["github-models"].baseUrl, "https://models.github.ai/inference");
  assert.deepEqual(PROVIDER_PROFILES["github-models"].apiKeyEnv, ["GITHUB_TOKEN", "GH_TOKEN"]);
  assert.equal(PROVIDER_PROFILES["github-models"].defaultModel, "openai/gpt-4o-mini");
  assert.equal(PROVIDER_PROFILES.deepseek.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(PROVIDER_PROFILES.glm.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  assert.equal(PROVIDER_PROFILES.ollama.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(PROVIDER_PROFILES.ollama.apiKeyEnv.length, 0, "local ollama needs no key");
});

test("resolveProviderSettings: env key on the default openai profile", async () => {
  const s = await resolveProviderSettings({ env: { LLM_API_KEY: "sk-env" } as unknown as NodeJS.ProcessEnv });
  assert.ok(s);
  assert.equal(s.profile.id, "openai");
  assert.equal(s.apiKey, "sk-env");
  assert.equal(s.keySource, "env");
  assert.equal(s.quirks.toolStreaming, true);
});

test("resolveProviderSettings: github-models via config picks up GITHUB_TOKEN", async () => {
  const s = await resolveProviderSettings({
    env: { GITHUB_TOKEN: "ghp_env" } as unknown as NodeJS.ProcessEnv,
    llm: { provider: "github-models", model: "openai/gpt-4.1-mini" },
  });
  assert.ok(s);
  assert.equal(s.baseUrl, "https://models.github.ai/inference");
  assert.equal(s.model, "openai/gpt-4.1-mini");
  assert.equal(s.apiKey, "ghp_env");
  assert.equal(s.keySource, "env");
});

test("resolveProviderSettings: named vault secret beats env; profile defaults apply", async () => {
  const dir = await tmpDir("agentos-prov-");
  try {
    const vault = new FileSecretVault(dir, await loadMasterKey(dir));
    await vault.set("PROXY_KEY", "sk-from-vault");
    const s = await resolveProviderSettings({
      env: { LLM_API_KEY: "sk-env" } as unknown as NodeJS.ProcessEnv,
      vault,
      llm: { provider: "custom", baseUrl: "https://my-proxy.example.com/v1", model: "gpt-x", apiKeySecret: "PROXY_KEY", toolStreaming: false, jsonMode: true, maxTokens: 4096 },
    });
    assert.ok(s);
    assert.equal(s.apiKey, "sk-from-vault", "named vault entry wins over env");
    assert.equal(s.keySource, "vault");
    assert.equal(s.quirks.toolStreaming, false, "explicit override");
    assert.equal(s.quirks.jsonMode, true);
    assert.equal(s.quirks.maxTokens, 4096);
    const provider = createProviderFromSettings(s);
    assert.equal(provider.name, "openai-compatible:gpt-x");
    assert.equal(provider.quirks?.toolStreaming, false, "quirks attached for the agentic loop");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("resolveProviderSettings: vault default entry used when env missing; null without any key", async () => {
  const dir = await tmpDir("agentos-prov2-");
  try {
    const vault = new FileSecretVault(dir, await loadMasterKey(dir));
    await vault.set("LLM_API_KEY", "sk-vault-default");
    const s = await resolveProviderSettings({ env: {} as NodeJS.ProcessEnv, vault });
    assert.equal(s?.apiKey, "sk-vault-default");
    assert.equal(s?.keySource, "vault");
    assert.equal(await resolveProviderSettings({ env: {} as NodeJS.ProcessEnv }), null, "no key → deterministic mode");
    const local = await resolveProviderSettings({ env: {} as NodeJS.ProcessEnv, llm: { provider: "ollama" } });
    assert.ok(local, "ollama is a keyless local profile and still resolves");
    assert.equal(local?.keySource, "none");
    assert.equal(local?.baseUrl, "http://127.0.0.1:11434/v1");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("config llm section validation", () => {
  const ok = validateAgentOsConfig({ llm: { provider: "github-models", model: "openai/gpt-4o-mini" }, sandbox: { mode: "container" } });
  assert.equal(ok.llm?.provider, "github-models");
  assert.equal(ok.sandbox?.mode, "container");
  assert.throws(() => validateAgentOsConfig({ llm: { provider: "nope" } }), /llm.provider/);
  assert.throws(() => validateAgentOsConfig({ llm: { baseUrl: "" } }), /llm.baseUrl/);
  assert.throws(() => validateAgentOsConfig({ llm: { toolStreaming: "yes" } }), /llm.toolStreaming/);
  assert.throws(() => validateAgentOsConfig({ llm: { maxTokens: 1 } }), /llm.maxTokens/);
  assert.throws(() => validateAgentOsConfig({ sandbox: { mode: "jail" } }), /none\|process\|container/);
});

test("repairToolArguments fixes the malformed shapes models actually emit", () => {
  assert.deepEqual(JSON.parse(repairToolArguments('{"path":"a.txt","content":"hi"}')), { path: "a.txt", content: "hi" }, "valid passes through");
  assert.deepEqual(JSON.parse(repairToolArguments('```json\n{"path":"a.txt"}\n```')), { path: "a.txt" }, "markdown fences");
  assert.deepEqual(JSON.parse(repairToolArguments('{"path":"a.txt", "content":"x",}')), { path: "a.txt", content: "x" }, "trailing comma");
  assert.deepEqual(JSON.parse(repairToolArguments('{"path":"caf\\u00e9"}')), { path: "café" }, "unicode untouched");
  assert.deepEqual(JSON.parse(repairToolArguments('{"path": “a.txt”}')), { path: "a.txt" }, "smart quotes");
  assert.deepEqual(JSON.parse(repairToolArguments('{"path":"a.txt"')), { path: "a.txt" }, "missing closer");
  assert.deepEqual(JSON.parse(repairToolArguments('{"a":{"b":[1,2]')), { a: { b: [1, 2] } }, "nested missing closers");
  assert.deepEqual(JSON.parse(repairToolArguments('{"path":"x"} trailing chatter')), { path: "x" }, "garbage after object");
  assert.deepEqual(JSON.parse(repairToolArguments('{"a": "unterminated')), { a: "unterminated" }, "unterminated string gets closed");
  // crossed closers are not repairable — the caller feeds the parse error back to the model
  assert.throws(() => JSON.parse(repairToolArguments('{"a": 1 ]')), SyntaxError);
});

test("balanceJson drops nothing for arrays", () => {
  assert.equal(balanceJson("[1,2,3"), "[1,2,3]");
  assert.equal(balanceJson('{"a":[1,{"b":2}'), '{"a":[1,{"b":2}]}');
});
