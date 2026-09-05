import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AgentOSError } from "./types";
import { Mutex } from "./persistence";

/**
 * Scoped API-key access system for the runtime's control surface (dashboard API,
 * cross-process control). Keys never live in plaintext: only a SHA-256 hash is
 * stored, the plaintext is returned exactly once at creation.
 *
 * - scopes: `tasks:read`, `tasks:write`, `admin` (implies everything)
 * - token-bucket rate limit per key (deterministic, injectable clock)
 * - every decision is auditable via `apikey.*` events (runtime wiring) — the
 *   key value itself never appears anywhere
 */

export const API_KEY_SCOPES = ["tasks:read", "tasks:write", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** sha256(key) hex — the plaintext is never stored. */
  hash: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface ApiKeyFileInfo {
  id: string;
  name: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

interface ApiKeyFile {
  version: 1;
  keys: ApiKeyRecord[];
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export class ApiKeyStore {
  readonly file: string;
  private mutex = new Mutex();
  private cache: ApiKeyFile | null = null;

  constructor(file: string) {
    this.file = path.normalize(file);
  }

  private async read(): Promise<ApiKeyFile> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, "utf8")) as ApiKeyFile;
      if (raw.version !== 1 || !Array.isArray(raw.keys)) throw new Error("bad shape");
      this.cache = raw;
    } catch {
      this.cache = { version: 1, keys: [] };
    }
    return this.cache;
  }

  private async write(v: ApiKeyFile): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await fsp.mkdir(path.dirname(this.file), { recursive: true }).catch(() => undefined);
    await fsp.writeFile(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  /** Creates a key; the plaintext `key` is returned exactly once and never stored. */
  async create(name: string, scopes: ApiKeyScope[]): Promise<{ id: string; key: string; record: ApiKeyFileInfo }> {
    if (!name.trim()) throw new AgentOSError("INVALID_KEY_NAME", "key name is required");
    if (!scopes.length) throw new AgentOSError("INVALID_KEY_SCOPES", "at least one scope is required");
    for (const s of scopes) {
      if (!API_KEY_SCOPES.includes(s)) throw new AgentOSError("INVALID_KEY_SCOPES", `unknown scope "${s}" (expected ${API_KEY_SCOPES.join(", ")})`);
    }
    const key = `aos_${randomBytes(24).toString("base64url")}`;
    const record: ApiKeyRecord = {
      id: `key_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
      name: name.trim().slice(0, 100),
      hash: hashApiKey(key),
      scopes: [...new Set(scopes)],
      createdAt: new Date().toISOString(),
    };
    await this.mutex.run(async () => {
      const v = await this.read();
      v.keys.push(record);
      this.cache = v;
      await this.write(v);
    });
    return { id: record.id, key, record: this.toInfo(record) };
  }

  async revoke(id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const v = await this.read();
      const rec = v.keys.find((k) => k.id === id);
      if (!rec || rec.revokedAt) return false;
      rec.revokedAt = new Date().toISOString();
      this.cache = v;
      await this.write(v);
      return true;
    });
  }

  async list(): Promise<ApiKeyFileInfo[]> {
    return (await this.read()).keys.map((k) => this.toInfo(k));
  }

  /** Verifies a presented key: hash lookup (timing-safe), revocation, scope check. */
  async verify(key: string, requiredScope: ApiKeyScope): Promise<{ ok: true; id: string } | { ok: false; status: 401 | 403; reason: string }> {
    if (!key) return { ok: false, status: 401, reason: "missing API key" };
    const hash = hashApiKey(key);
    const v = await this.read();
    const rec = v.keys.find((k) => timingSafeEqual(Buffer.from(k.hash, "hex"), Buffer.from(hash, "hex")));
    if (!rec) return { ok: false, status: 401, reason: "unknown API key" };
    if (rec.revokedAt) return { ok: false, status: 401, reason: `API key ${rec.id} is revoked` };
    // "admin" scope implies everything; a request FOR admin scope requires an admin key
    if (!rec.scopes.includes(requiredScope) && !rec.scopes.includes("admin")) {
      return { ok: false, status: 403, reason: `API key ${rec.id} lacks scope "${requiredScope}"` };
    }
    rec.lastUsedAt = new Date().toISOString();
    this.cache = v;
    await this.write(v).catch(() => undefined); // lastUsedAt tracking is best-effort
    return { ok: true, id: rec.id };
  }

  private toInfo(k: ApiKeyRecord): ApiKeyFileInfo {
    const { hash: _hash, ...info } = k;
    void _hash;
    return info;
  }
}

/** Loads the key store; null when `.agentos/apikeys.json` does not exist (auth disabled). */
export async function loadApiKeyStore(dataDir: string): Promise<ApiKeyStore | null> {
  const file = path.join(dataDir, "apikeys.json");
  try {
    await fsp.access(file);
  } catch {
    return null;
  }
  return new ApiKeyStore(file);
}

/** Deterministic token bucket (rate limit per key). */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(readonly capacity: number, readonly refillPerMinute: number, private now: () => number = Date.now) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  take(n = 1): boolean {
    const elapsedMin = (this.now() - this.lastRefill) / 60_000;
    if (elapsedMin > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedMin * this.refillPerMinute);
      this.lastRefill = this.now();
    }
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export interface AuthDecision {
  allowed: boolean;
  status: 200 | 401 | 403 | 429;
  reason: string;
  keyId?: string;
}

/**
 * Authorization front-door: verifies the presented key, checks the scope, and
 * applies the per-key token bucket. Decisions are returned for audit logging.
 */
export class ApiKeyAuthorizer {
  private buckets = new Map<string, TokenBucket>();
  constructor(
    private store: ApiKeyStore,
    private opts: { capacity?: number; refillPerMinute?: number; now?: () => number; onDecision?: (d: AuthDecision) => void } = {},
  ) {}

  /** `authValue` is the raw `Authorization: Bearer <key>` payload (or null). */
  async authorize(authValue: string | null, requiredScope: ApiKeyScope): Promise<AuthDecision> {
    const verdict = await this.store.verify(authValue ?? "", requiredScope);
    let decision: AuthDecision;
    if (!verdict.ok) decision = { allowed: false, status: verdict.status as 401 | 403, reason: verdict.reason };
    else {
      let bucket = this.buckets.get(verdict.id);
      if (!bucket) {
        bucket = new TokenBucket(this.opts.capacity ?? 120, this.opts.refillPerMinute ?? 120, this.opts.now);
        this.buckets.set(verdict.id, bucket);
      }
      decision = bucket.take()
        ? { allowed: true, status: 200, reason: "ok", keyId: verdict.id }
        : { allowed: false, status: 429, reason: `rate limit exceeded for ${verdict.id}`, keyId: verdict.id };
    }
    this.opts.onDecision?.(decision);
    return decision;
  }
}
