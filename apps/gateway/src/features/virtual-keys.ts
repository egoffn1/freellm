/**
 * Virtual sub-keys with in-memory rolling-24h caps.
 *
 * Operators declare a JSON file like:
 *
 *     {
 *       "keys": [
 *         {
 *           "id": "sk-freellm-portfolio-a1b2c3",
 *           "label": "My portfolio site",
 *           "dailyRequestCap": 500,
 *           "dailyTokenCap": 200000,
 *           "allowedModels": ["free-fast", "free"],
 *           "expiresAt": "2026-07-01T00:00:00Z"
 *         }
 *       ]
 *     }
 *
 * The path is `FREELLM_VIRTUAL_KEYS_PATH` (defaults to
 * `./virtual-keys.json`). The file is loaded synchronously at boot,
 * validated with Zod, and never written to. Every constraint the
 * operator wants to enforce lives in that file.
 *
 * Counter semantics: in-memory rolling 24h window tracked with request
 * timestamps (not a wall-clock "daily reset"). This is consistent with
 * every other counter in the gateway (cache, usage-tracker, rate
 * limiter) and means a restart clears all counters. Documented as a
 * SOFT CAP. It protects against runaway loops and abuse; it is not a
 * billing system.
 *
 * Caps composition:
 *   - virtual key cap is checked AND incremented per successful request
 *   - identifier rate limit is a separate, composable middleware
 *   - both must pass before a request reaches the upstream provider
 */

import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { logger } from "../logger.js";

const KEY_ID_PATTERN = /^sk-freellm-[A-Za-z0-9_-]{4,128}$/;
const MAX_FILE_BYTES = 1_048_576; // 1 MB
const WINDOW_MS = 24 * 60 * 60 * 1_000; // rolling 24h

const virtualKeySchema = z.object({
  id: z.string().regex(KEY_ID_PATTERN),
  label: z.string().min(1).max(128),
  dailyRequestCap: z.number().int().positive().optional(),
  dailyTokenCap: z.number().int().positive().optional(),
  allowedModels: z.array(z.string().min(1)).optional(),
  expiresAt: z.string().datetime().optional(),
});

const virtualKeysFileSchema = z.object({
  keys: z.array(virtualKeySchema),
});

export type VirtualKey = z.infer<typeof virtualKeySchema>;

export interface VirtualKeyUsage {
  requestsInWindow: number;
  tokensInWindow: number;
  requestCapRemaining: number | null;
  tokenCapRemaining: number | null;
}

interface Counter {
  /** Per-request timestamps for the rolling-window request cap. */
  requestTimes: number[];
  /** Per-request tokens for the rolling-window token cap. */
  tokenEvents: Array<{ at: number; tokens: number }>;
}

export class VirtualKeysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirtualKeysError";
  }
}

/**
 * Hold the parsed file in memory and track per-key counters. Exposed
 * as a class so tests can instantiate isolated stores without touching
 * the singleton used by production code.
 */
export class VirtualKeyStore {
  private keysById = new Map<string, VirtualKey>();
  private counters = new Map<string, Counter>();

  constructor(keys: VirtualKey[]) {
    for (const key of keys) {
      if (this.keysById.has(key.id)) {
        throw new VirtualKeysError(`duplicate virtual key id: ${key.id}`);
      }
      this.keysById.set(key.id, key);
      this.counters.set(key.id, { requestTimes: [], tokenEvents: [] });
    }
  }

  /** How many keys are loaded. */
  size(): number {
    return this.keysById.size;
  }

  /** List all loaded keys (read-only snapshot). */
  list(): VirtualKey[] {
    return [...this.keysById.values()];
  }

  /** Look up by the raw Authorization bearer token. */
  findByToken(token: string): VirtualKey | undefined {
    return this.keysById.get(token);
  }

  /**
   * Check whether the key may serve one more request for the given model.
   * Throws a plain Error carrying a code string the chat route translates
   * into the public FreeLLMError taxonomy.
   */
  assertCanServe(key: VirtualKey, model: string, now: number = Date.now()): void {
    if (key.expiresAt) {
      const expiresMs = Date.parse(key.expiresAt);
      if (Number.isFinite(expiresMs) && now > expiresMs) {
        throw new VirtualKeyCheckError("expired", `virtual key ${key.id} is expired`);
      }
    }

    if (key.allowedModels && key.allowedModels.length > 0) {
      if (!key.allowedModels.includes(model)) {
        throw new VirtualKeyCheckError(
          "model_not_allowed",
          `virtual key ${key.id} does not allow model "${model}"`,
        );
      }
    }

    let counter = this.counters.get(key.id);
    if (!counter) {
      counter = { requestTimes: [], tokenEvents: [] };
      this.counters.set(key.id, counter);
    }
    this.prune(counter, now);

    if (key.dailyRequestCap != null && counter.requestTimes.length >= key.dailyRequestCap) {
      throw new VirtualKeyCheckError(
        "request_cap_reached",
        `virtual key ${key.id} exhausted its 24h request cap (${key.dailyRequestCap})`,
      );
    }

    if (key.dailyTokenCap != null) {
      const usedTokens = counter.tokenEvents.reduce((a, e) => a + e.tokens, 0);
      if (usedTokens >= key.dailyTokenCap) {
        throw new VirtualKeyCheckError(
          "token_cap_reached",
          `virtual key ${key.id} exhausted its 24h token cap (${key.dailyTokenCap})`,
        );
      }
    }
  }

  /**
   * Record a successful request and its token usage. Call AFTER the
   * upstream response comes back so failed routes do not consume cap.
   */
  recordRequest(key: VirtualKey, tokens: number, now: number = Date.now()): void {
    const counter = this.counters.get(key.id);
    if (!counter) return;
    this.prune(counter, now);
    counter.requestTimes.push(now);
    if (tokens > 0) counter.tokenEvents.push({ at: now, tokens });
  }

  /** Current usage for the dashboard / status endpoint. */
  usage(keyId: string, now: number = Date.now()): VirtualKeyUsage | undefined {
    const key = this.keysById.get(keyId);
    const counter = this.counters.get(keyId);
    if (!key || !counter) return undefined;
    this.prune(counter, now);
    const tokens = counter.tokenEvents.reduce((a, e) => a + e.tokens, 0);
    return {
      requestsInWindow: counter.requestTimes.length,
      tokensInWindow: tokens,
      requestCapRemaining:
        key.dailyRequestCap != null
          ? Math.max(0, key.dailyRequestCap - counter.requestTimes.length)
          : null,
      tokenCapRemaining: key.dailyTokenCap != null ? Math.max(0, key.dailyTokenCap - tokens) : null,
    };
  }

  private prune(counter: Counter, now: number): void {
    const windowStart = now - WINDOW_MS;
    counter.requestTimes = counter.requestTimes.filter((t) => t > windowStart);
    counter.tokenEvents = counter.tokenEvents.filter((e) => e.at > windowStart);
  }
}

/**
 * Distinct error class so the chat route can `instanceof` match without
 * importing the FreeLLMError SDK here (keeps this module gateway-only).
 */
export class VirtualKeyCheckError extends Error {
  constructor(
    public readonly reason:
      | "expired"
      | "model_not_allowed"
      | "request_cap_reached"
      | "token_cap_reached",
    message: string,
  ) {
    super(message);
    this.name = "VirtualKeyCheckError";
  }
}

/**
 * Load a virtual-keys file from disk. Validates size, JSON parsing, and
 * schema before constructing a store. Throws `VirtualKeysError` on any
 * failure with a clear message the boot log can surface.
 */
export function loadVirtualKeysFromFile(path: string): VirtualKeyStore {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (err) {
    throw new VirtualKeysError(
      `cannot stat virtual keys file at ${path}: ${(err as Error).message}`,
    );
  }

  if (stat.size > MAX_FILE_BYTES) {
    throw new VirtualKeysError(
      `virtual keys file ${path} is ${stat.size} bytes, limit is ${MAX_FILE_BYTES}`,
    );
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new VirtualKeysError(
      `virtual keys file ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = virtualKeysFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    throw new VirtualKeysError(`virtual keys file schema error: ${issues}`);
  }

  return new VirtualKeyStore(result.data.keys);
}

/** Empty store used when `FREELLM_VIRTUAL_KEYS_PATH` is not set. */
export function emptyVirtualKeyStore(): VirtualKeyStore {
  return new VirtualKeyStore([]);
}

/**
 * Load the store from env-configured path. Returns an empty store if the
 * env var is unset. Throws on any parsing / validation failure so the
 * server refuses to boot with a broken config.
 */
export function loadVirtualKeysFromEnv(): VirtualKeyStore {
  const path = process.env.FREELLM_VIRTUAL_KEYS_PATH;
  if (!path) return emptyVirtualKeyStore();
  const store = loadVirtualKeysFromFile(path);
  logger.info(
    { path, keyCount: store.size() },
    "virtual keys loaded (SOFT CAPS ONLY -- counters reset on restart)",
  );
  return store;
}

/**
 * Process-wide virtual key store. Loaded once at boot from
 * `FREELLM_VIRTUAL_KEYS_PATH` via `loadVirtualKeysFromEnv()`. Middleware
 * and route handlers import the singleton through this module to avoid
 * circular imports between `middleware/` and `gateway/`.
 */

let _store: VirtualKeyStore = emptyVirtualKeyStore();
let _initialized = false;

export function initVirtualKeys(): VirtualKeyStore {
  if (_initialized) return _store;
  _store = loadVirtualKeysFromEnv();
  _initialized = true;
  return _store;
}

/** Overwrite the store. Used by tests that need a custom config. */
export function setVirtualKeyStore(next: VirtualKeyStore): void {
  _store = next;
  _initialized = true;
}

export function getVirtualKeyStore(): VirtualKeyStore {
  return _store;
}
