import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { FileSecretVault, loadMasterKey, loadVault } from "@/agentos/secrets";
import { tmpDir } from "../helpers";

test("vault roundtrip: set/get/list/delete", async () => {
  const dir = await tmpDir("agentos-vault-");
  try {
    const key = await loadMasterKey(dir);
    const vault = new FileSecretVault(dir, key);
    assert.deepEqual(await vault.list(), []);
    await vault.set("LLM_API_KEY", "sk-test-value-123");
    await vault.set("GITHUB_TOKEN", "ghp_test_value");
    assert.deepEqual(await vault.list(), ["GITHUB_TOKEN", "LLM_API_KEY"]);
    assert.equal(await vault.get("LLM_API_KEY"), "sk-test-value-123");
    assert.equal(await vault.get("GITHUB_TOKEN"), "ghp_test_value");
    assert.equal(await vault.get("MISSING"), null);
    // the stored file never contains plaintext
    const raw = await fsp.readFile(path.join(dir, "secrets.json"), "utf8");
    assert.ok(!raw.includes("sk-test-value-123"), "ciphertext only on disk");
    assert.ok(!raw.includes("ghp_test_value"));
    assert.equal(await vault.delete("LLM_API_KEY"), true);
    assert.equal(await vault.delete("LLM_API_KEY"), false);
    assert.equal(await vault.get("LLM_API_KEY"), null);
    // master key file exists with restrictive mode (best-effort on win32)
    const stat = await fsp.stat(path.join(dir, "secret.key"));
    assert.ok(stat.isFile());
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("vault rejects invalid names and empty values", async () => {
  const dir = await tmpDir("agentos-vault2-");
  try {
    const vault = new FileSecretVault(dir, await loadMasterKey(dir));
    await assert.rejects(vault.set("bad name!", "x"), (err: Error & { code?: string }) => err.code === "SECRET_NAME_INVALID");
    await assert.rejects(vault.set("1STARTSWITHDIGIT", "x"), (err: Error & { code?: string }) => err.code === "SECRET_NAME_INVALID");
    await assert.rejects(vault.set("OK_NAME", ""), (err: Error & { code?: string }) => err.code === "SECRET_VALUE_EMPTY");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("vault fails closed when the master key changed", async () => {
  const dir = await tmpDir("agentos-vault3-");
  try {
    const vaultA = new FileSecretVault(dir, Buffer.from(randomHex(), "hex"));
    await vaultA.set("TOKEN", "secret-value");
    // a vault opened with a different master key cannot decrypt
    const vaultB = new FileSecretVault(dir, Buffer.from(randomHex(), "hex"));
    await assert.rejects(vaultB.get("TOKEN"), (err: Error & { code?: string }) => err.code === "SECRET_DECRYPT_FAILED");
    // the original key still decrypts
    assert.equal(await vaultA.get("TOKEN"), "secret-value");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("AGENTOS_SECRET_KEY env wins over the key file; loadVault returns null without secrets.json", async () => {
  const dir = await tmpDir("agentos-vault4-");
  const keyHex = randomHex();
  try {
    assert.equal(await loadVault(dir), null, "no secrets.json → no vault");
    const env = { AGENTOS_SECRET_KEY: keyHex } as unknown as NodeJS.ProcessEnv;
    const key1 = await loadMasterKey(dir, env);
    const key2 = await loadMasterKey(dir, env);
    assert.equal(key1.toString("hex"), keyHex);
    assert.equal(key2.toString("hex"), keyHex, "env key is used directly, no key file written");
    const vault = new FileSecretVault(dir, key1);
    await vault.set("TOKEN", "v");
    const reopened = await loadVault(dir, env);
    assert.equal(await reopened!.get("TOKEN"), "v");
    // a fresh process without the env key (new random key file) cannot decrypt the same store
    const fresh = await loadVault(dir);
    await assert.rejects(fresh!.get("TOKEN"), (err: Error & { code?: string }) => err.code === "SECRET_DECRYPT_FAILED");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

function randomHex(): string {
  return Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
}
