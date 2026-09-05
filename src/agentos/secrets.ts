import fsp from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AgentOSError } from "./types";
import { Mutex } from "./persistence";

/**
 * Encrypted local secret vault (`.agentos/secrets.json`, AES-256-GCM).
 *
 * Threat model: protects keys at rest from casual file reads / accidental commits —
 * the master key lives in `<dataDir>/secret.key` (0600) or `AGENTOS_SECRET_KEY`.
 * This is a local developer vault, not an HSM; anyone who can read both files can
 * decrypt. Every access decision is visible to the runtime (names only, never values,
 * and event redaction covers `apiKey`, `token`, `secret` shaped keys anyway).
 */

export interface SecretVault {
  /** Encrypts and stores a secret (upsert). */
  set(name: string, value: string): Promise<void>;
  /** Decrypts a secret; null when absent. Throws SECRET_DECRYPT_FAILED on a wrong master key. */
  get(name: string): Promise<string | null>;
  /** Removes a secret; true when it existed. */
  delete(name: string): Promise<boolean>;
  /** Secret names only — never values. */
  list(): Promise<string[]>;
  readonly file: string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, { iv: string; tag: string; data: string; createdAt: string }>;
}

const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Loads/creates the master key: AGENTOS_SECRET_KEY (hex) wins, else `<dataDir>/secret.key` (created 0600). */
export async function loadMasterKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  if (env.AGENTOS_SECRET_KEY) {
    const buf = Buffer.from(env.AGENTOS_SECRET_KEY, "hex");
    if (buf.length !== 32) throw new AgentOSError("SECRET_KEY_INVALID", "AGENTOS_SECRET_KEY must be 64 hex chars (32 bytes)");
    return buf;
  }
  const keyFile = path.join(dataDir, "secret.key");
  try {
    const buf = Buffer.from(await fsp.readFile(keyFile, "utf8"), "hex");
    if (buf.length === 32) return buf;
  } catch {
    // create below
  }
  const buf = randomBytes(32);
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(keyFile, buf.toString("hex") + "\n", { mode: 0o600 });
  return buf;
}

export class FileSecretVault implements SecretVault {
  readonly file: string;
  private mutex = new Mutex();
  private cache: VaultFile | null = null;

  constructor(private dataDir: string, private masterKey: Buffer) {
    this.file = path.join(dataDir, "secrets.json");
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString("base64"), tag: tag.toString("base64"), data: data.toString("base64") };
  }

  private decrypt(entry: { iv: string; tag: string; data: string }): string {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.masterKey, Buffer.from(entry.iv, "base64"));
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]);
      const value = plain.toString("utf8");
      plain.fill(0); // best-effort zeroization
      return value;
    } catch {
      throw new AgentOSError("SECRET_DECRYPT_FAILED", `cannot decrypt secrets.json — the master key changed (delete ${this.file} and re-enter secrets, or restore AGENTOS_SECRET_KEY / secret.key)`);
    }
  }

  private async read(): Promise<VaultFile> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, "utf8")) as VaultFile;
      if (raw.version !== 1 || typeof raw.entries !== "object") throw new Error("bad shape");
      this.cache = raw;
    } catch {
      this.cache = { version: 1, entries: {} };
    }
    return this.cache;
  }

  private async write(v: VaultFile): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  async set(name: string, value: string): Promise<void> {
    if (!SECRET_NAME_RE.test(name)) throw new AgentOSError("SECRET_NAME_INVALID", "secret name must match [A-Za-z][A-Za-z0-9_]{0,63}");
    if (!value) throw new AgentOSError("SECRET_VALUE_EMPTY", "secret value must not be empty");
    await this.mutex.run(async () => {
      const v = await this.read();
      v.entries[name] = { ...this.encrypt(value), createdAt: new Date().toISOString() };
      this.cache = v;
      await this.write(v);
    });
  }

  async get(name: string): Promise<string | null> {
    const v = await this.read();
    const entry = v.entries[name];
    if (!entry) return null;
    return this.decrypt(entry);
  }

  async delete(name: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const v = await this.read();
      if (!v.entries[name]) return false;
      delete v.entries[name];
      this.cache = v;
      await this.write(v);
      return true;
    });
  }

  async list(): Promise<string[]> {
    const v = await this.read();
    return Object.keys(v.entries).sort();
  }
}

/** Loads the vault for a data dir; null when no secrets.json exists yet (nothing stored). */
export async function loadVault(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<FileSecretVault | null> {
  try {
    await fsp.access(path.join(dataDir, "secrets.json"));
  } catch {
    return null;
  }
  const key = await loadMasterKey(dataDir, env);
  return new FileSecretVault(dataDir, key);
}
