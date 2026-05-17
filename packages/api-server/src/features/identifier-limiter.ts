/**
 * Per-identifier sliding-window rate limiter.
 *
 * Clients pass an `X-FreeLLM-Identifier` header tagging each request with
 * a logical identity (usually an app user id or session token) and this
 * limiter tracks requests per identifier in its own bucket. Independent
 * from the per-provider limiter, the per-IP limiter, and virtual-key caps.
 *
 * Design notes:
 *
 * - Every state mutation (`checkAndRecord`) is synchronous so two
 *   concurrent requests cannot race between "read count" and "write
 *   count" inside one Node event loop turn. No `await` crosses a
 *   critical section.
 *
 * - Memory is bounded. The bucket Map has a hard ceiling
 *   (`FREELLM_IDENTIFIER_MAX_BUCKETS`, default 10_000) and we LRU-evict
 *   the stalest identifier on overflow. An attacker sending requests
 *   with unique identifiers cannot grow the Map beyond the ceiling.
 *
 * - Idle identifiers are garbage-collected: on every write we lazily
 *   drop any bucket whose `lastSeen` is older than 2x the window. This
 *   is bounded amortized O(N) with N capped by the ceiling above.
 *
 * - The window is sliding, not fixed. We store per-identifier request
 *   timestamps and prune entries older than `windowMs` on every check.
 *
 * - Nothing here knows about Express or the HTTP request object. The
 *   middleware wraps this module.
 */

export interface IdentifierLimiterConfig {
  /** Maximum requests allowed per identifier in the window. */
  max: number;
  /** Sliding window size in ms. */
  windowMs: number;
  /** Hard ceiling on distinct identifiers we will track. */
  maxBuckets: number;
}

interface Bucket {
  /** Monotonically-appended request timestamps, pruned on every check. */
  timestamps: number[];
  /** Wall-clock of the most recent access. Used for LRU + TTL eviction. */
  lastSeen: number;
}

export interface CheckResult {
  allowed: boolean;
  /** Remaining requests in the current window AFTER this call. */
  remaining: number;
  /** Wall-clock in ms when the earliest slot frees up, relative to now. */
  resetAfterMs: number;
  /** The identifier we decided to bucket this request against. */
  identifier: string;
}

export class IdentifierLimiter {
  private buckets = new Map<string, Bucket>();
  private config: IdentifierLimiterConfig;

  constructor(config: IdentifierLimiterConfig) {
    if (config.max < 1) throw new Error("IdentifierLimiter.max must be >= 1");
    if (config.windowMs < 1) throw new Error("IdentifierLimiter.windowMs must be >= 1");
    if (config.maxBuckets < 1) throw new Error("IdentifierLimiter.maxBuckets must be >= 1");
    this.config = config;
  }

  /**
   * Check whether the identifier is allowed and, if so, record the request.
   * Never throws. Returns a result describing the post-call state.
   *
   * SYNCHRONOUS by design. Do not introduce any `await` between the
   * read-prune-decide-write sequence below or concurrent requests will
   * race on the same bucket.
   */
  checkAndRecord(identifier: string, now: number = Date.now()): CheckResult {
    this.pruneIdleBuckets(now);

    let bucket = this.buckets.get(identifier);
    if (!bucket) {
      // Enforce the hard ceiling BEFORE allocating a new bucket.
      if (this.buckets.size >= this.config.maxBuckets) {
        this.evictStalest();
      }
      bucket = { timestamps: [], lastSeen: now };
      this.buckets.set(identifier, bucket);
    }

    // Prune timestamps outside the window.
    const windowStart = now - this.config.windowMs;
    const fresh: number[] = [];
    for (const t of bucket.timestamps) {
      if (t > windowStart) fresh.push(t);
    }
    bucket.timestamps = fresh;
    bucket.lastSeen = now;
    // Re-insert to mark as most-recently-used (Map iteration order = insertion order).
    this.buckets.delete(identifier);
    this.buckets.set(identifier, bucket);

    if (bucket.timestamps.length >= this.config.max) {
      // Reject. Report how long until the oldest in-window slot expires.
      const oldest = bucket.timestamps[0]!;
      const resetAfterMs = Math.max(0, oldest + this.config.windowMs - now);
      return {
        allowed: false,
        remaining: 0,
        resetAfterMs,
        identifier,
      };
    }

    bucket.timestamps.push(now);
    return {
      allowed: true,
      remaining: this.config.max - bucket.timestamps.length,
      resetAfterMs: this.config.windowMs,
      identifier,
    };
  }

  /** Drop buckets that have been idle for more than 2x the window. */
  private pruneIdleBuckets(now: number): void {
    const idleCutoff = now - this.config.windowMs * 2;
    for (const [id, bucket] of this.buckets) {
      if (bucket.lastSeen < idleCutoff) {
        this.buckets.delete(id);
      }
    }
  }

  /** Remove the single stalest bucket (iteration order = insertion order). */
  private evictStalest(): void {
    const firstKey = this.buckets.keys().next().value;
    if (firstKey !== undefined) this.buckets.delete(firstKey);
  }

  /** Current number of tracked identifiers. Useful for tests + metrics. */
  size(): number {
    return this.buckets.size;
  }

  /** Clear all buckets. Used by tests and admin endpoints. */
  reset(): void {
    this.buckets.clear();
  }
}

const DEFAULT_MAX = 60;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_BUCKETS = 10_000;

/**
 * Parse `FREELLM_IDENTIFIER_LIMIT` of the form `<max>/<windowMs>`.
 * Invalid values fall back to the defaults and emit no error (the
 * environment variable is optional and the default is safe).
 */
export function parseIdentifierLimitEnv(
  value: string | undefined,
  maxBuckets: number = DEFAULT_MAX_BUCKETS,
): IdentifierLimiterConfig {
  if (!value) return { max: DEFAULT_MAX, windowMs: DEFAULT_WINDOW_MS, maxBuckets };
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value);
  if (!match) return { max: DEFAULT_MAX, windowMs: DEFAULT_WINDOW_MS, maxBuckets };
  const max = parseInt(match[1]!, 10);
  const windowMs = parseInt(match[2]!, 10);
  if (max < 1 || windowMs < 1) {
    return { max: DEFAULT_MAX, windowMs: DEFAULT_WINDOW_MS, maxBuckets };
  }
  return { max, windowMs, maxBuckets };
}
