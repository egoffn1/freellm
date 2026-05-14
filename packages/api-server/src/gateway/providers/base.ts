import { CircuitBreaker } from "../circuit-breaker.js";
import { RateLimiter } from "../rate-limiter.js";
import type { ProviderAdapter } from "./types.js";
import type {
  ChatCompletionRequest,
  KeyStatus,
  ModelObject,
  ProviderStats,
  CircuitBreakerState,
} from "../types.js";

/** Parse a comma-separated env var into a trimmed, filtered key array. */
export function parseApiKeys(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export abstract class BaseProvider implements ProviderAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly baseUrl: string;
  abstract readonly models: ModelObject[];
  readonly supportsStreamUsage: boolean = false;
  readonly supportsTools: boolean = true;

  protected circuitBreaker = new CircuitBreaker();
  protected rateLimiter = new RateLimiter();
  protected stats: ProviderStats = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    rateLimitedRequests: 0,
  };

  /** Next key to try when rotating. Synchronously advanced on each pick. */
  private keyRotationIndex = 0;

  /**
   * Maps each outgoing Response to the tracking ID of the key that produced it.
   * This is how onSuccess / onRateLimit attribute events to the correct key
   * without race conditions between concurrent requests.
   */
  private responseKeyMap = new WeakMap<Response, string>();

  /** Subclasses return the list of configured API keys (may be empty). */
  protected abstract getApiKeys(): string[];

  /** Build the tracking ID for a given key index. */
  protected trackingId(keyIndex: number): string {
    return `${this.id}#${keyIndex}`;
  }

  isEnabled(): boolean {
    return this.getApiKeys().length > 0;
  }

  getStats(): ProviderStats {
    return { ...this.stats };
  }

  getCircuitBreakerState(): CircuitBreakerState {
    return this.circuitBreaker.getState();
  }

  /**
   * Available when enabled, circuit closed, AND at least one key is not rate-limited.
   * A single rate-limited key shouldn't disable the whole provider.
   */
  isAvailable(): boolean {
    if (!this.isEnabled()) return false;
    if (!this.circuitBreaker.isAllowed()) return false;
    const keys = this.getApiKeys();
    for (let i = 0; i < keys.length; i++) {
      if (!this.rateLimiter.isRateLimited(this.trackingId(i))) return true;
    }
    return false;
  }

  /** Per-key status for observability (dashboard, /v1/status). */
  getKeysStatus(): KeyStatus[] {
    const keys = this.getApiKeys();
    return keys.map((_, i) => {
      const trackingId = this.trackingId(i);
      const stats = this.rateLimiter.getWindowStats(trackingId);
      return {
        index: i,
        rateLimited: this.rateLimiter.isRateLimited(trackingId),
        requestsInWindow: stats.requestsInWindow,
        maxRequests: stats.maxRequests,
        retryAfterMs: stats.retryAfterMs,
      };
    });
  }

  /**
   * Attribute a Response object to a specific key's tracking ID.
   * Called by complete() (and subclass overrides) so onSuccess/onRateLimit
   * can update rate-limiter state for the right key.
   */
  protected attachResponseToKey(response: Response, trackingId: string): void {
    this.responseKeyMap.set(response, trackingId);
  }

  /**
   * Pick the next available key via round-robin, starting from the rotation index.
   * Returns `undefined` if all keys are rate-limited.
   * The rotation index is advanced synchronously so concurrent calls spread across keys.
   */
  protected pickKey(): { key: string; trackingId: string; keyIndex: number } | undefined {
    const keys = this.getApiKeys();
    if (keys.length === 0) return undefined;

    for (let i = 0; i < keys.length; i++) {
      const idx = (this.keyRotationIndex + i) % keys.length;
      const trackingId = this.trackingId(idx);
      if (!this.rateLimiter.isRateLimited(trackingId)) {
        this.keyRotationIndex = (idx + 1) % keys.length;
        return { key: keys[idx]!, trackingId, keyIndex: idx };
      }
    }
    return undefined;
  }

  async complete(request: ChatCompletionRequest): Promise<Response> {
    const picked = this.pickKey();
    if (!picked) {
      throw new Error(
        `Provider ${this.name} has no available keys (all rate-limited or not configured)`,
      );
    }

    this.stats.totalRequests++;
    this.stats.lastUsedAt = new Date().toISOString();
    this.rateLimiter.recordRequest(picked.trackingId);

    const mapped = this.mapRequest(request);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${picked.key}`,
        ...this.extraHeaders(),
      },
      body: JSON.stringify(mapped),
    });

    // Remember which key produced this Response so onSuccess/onRateLimit
    // can attribute the result correctly under concurrency.
    this.attachResponseToKey(response, picked.trackingId);
    return response;
  }

  protected mapRequest(request: ChatCompletionRequest): ChatCompletionRequest {
    const mapped = { ...request };
    const prefix = `${this.id}/`;
    if (mapped.model.startsWith(prefix)) {
      mapped.model = mapped.model.slice(prefix.length);
    }
    return mapped;
  }

  protected extraHeaders(): Record<string, string> {
    return {};
  }

  onSuccess(response: Response): void {
    this.stats.successRequests++;
    this.circuitBreaker.onSuccess();
    const trackingId = this.responseKeyMap.get(response);
    if (trackingId) this.rateLimiter.clearRateLimit(trackingId);
  }

  onRateLimit(response: Response, retryAfterSeconds?: number): void {
    this.stats.rateLimitedRequests++;
    const trackingId = this.responseKeyMap.get(response);
    if (trackingId) {
      this.rateLimiter.markRateLimited(trackingId, retryAfterSeconds);
    }
  }

  onError(): void {
    this.stats.failedRequests++;
    this.circuitBreaker.onFailure();
    this.stats.lastError = new Date().toISOString();
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
    // Clear rate-limit cooldowns on ALL keys when admin resets the provider
    const keys = this.getApiKeys();
    for (let i = 0; i < keys.length; i++) {
      this.rateLimiter.clearRateLimit(this.trackingId(i));
    }
  }
}
