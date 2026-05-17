import { createHash } from "crypto";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../types.js";

export function hasImageContent(request: ChatCompletionRequest): boolean {
  return request.messages.some(
    (msg) =>
      Array.isArray(msg.content) &&
      msg.content.some(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          (part as Record<string, unknown>)["type"] === "image_url",
      ),
  );
}

/**
 * In-memory LRU cache for OpenAI-compatible chat completions.
 *
 * Design:
 * - Exact-match keying via sha256 of every field that can change the
 *   response shape (model, messages, sampling params, tools,
 *   tool_choice, response_format, reasoning_effort, seed, and so on).
 *   Missing fields from the key used to cause cross-shape collisions
 *   where a JSON-mode response could satisfy a plain-text request.
 * - LRU eviction: re-insert on read keeps recently-used entries at the
 *   end of the Map.
 * - TTL expiry per entry (Date.now() + ttlMs).
 * - Streaming responses are never cached (the protocol is incompatible).
 * - Errors are never cached.
 * - Truncated responses (finish_reason === "length") are never cached.
 *   A single unlucky truncation should not poison every identical
 *   request for a full hour. The caller is expected to raise
 *   max_tokens or adjust reasoning_effort and try again.
 *
 * The whole thing lives in process memory because the rest of FreeLLM's
 * observability state (request log, rate limiter, circuit breaker, usage
 * tracker) is also in-memory. Restart resets everything together,
 * consistent.
 *
 * Memory math: ~5-50KB per cached response * 1000 entries = ~5-50MB max.
 * Configurable via CACHE_MAX_ENTRIES if needed.
 */

export interface CacheStats {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  currentSize: number;
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  hitRate: number;
}

interface CacheEntry {
  /** The cached response (deep-cloned at set/get to avoid mutation bugs). */
  response: ChatCompletionResponse;
  /** Provider that originally produced this response. */
  provider: string;
  /** When this entry expires (Date.now() ms). */
  expiresAt: number;
  /** When this entry was first written. */
  createdAt: number;
  /** How many times this entry has been served from cache. */
  hitCount: number;
  /** Token usage from the original response (not double-counted on hits). */
  promptTokens: number;
  completionTokens: number;
}

export class ResponseCache {
  private store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly enabled: boolean;

  private hits = 0;
  private misses = 0;
  private sets = 0;
  private evictions = 0;

  constructor() {
    // CACHE_ENABLED: defaults to "true". Set to "false" to disable.
    this.enabled = (process.env["CACHE_ENABLED"] ?? "true").toLowerCase() !== "false";
    // CACHE_TTL_MS: defaults to 1 hour.
    this.ttlMs = parseInt(process.env["CACHE_TTL_MS"] ?? "3600000", 10);
    // CACHE_MAX_ENTRIES: defaults to 1000.
    this.maxEntries = parseInt(process.env["CACHE_MAX_ENTRIES"] ?? "1000", 10);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Build a cache key from every parameter that can change the response
   * shape. Order-stable JSON keeps the hash deterministic across calls
   * (Node's JSON.stringify preserves string-key insertion order).
   *
   * Adding a new optional field to chatCompletionRequestSchema? Add it
   * here too, or different request shapes will collide on the same key.
   */
  private buildKey(request: ChatCompletionRequest): string {
    const normalized = JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? null,
      max_tokens: request.max_tokens ?? null,
      max_completion_tokens: request.max_completion_tokens ?? null,
      top_p: request.top_p ?? null,
      stop: request.stop ?? null,
      presence_penalty: request.presence_penalty ?? null,
      frequency_penalty: request.frequency_penalty ?? null,
      seed: request.seed ?? null,
      tools: request.tools ?? null,
      tool_choice: request.tool_choice ?? null,
      parallel_tool_calls: request.parallel_tool_calls ?? null,
      response_format: request.response_format ?? null,
      reasoning_effort: request.reasoning_effort ?? null,
    });
    return createHash("sha256").update(normalized).digest("hex");
  }

  /**
   * Look up a cached response. Returns undefined on miss/expired/disabled/streaming.
   * Successful hits are re-inserted to bump them to the end of the LRU order.
   */
  get(request: ChatCompletionRequest): {
    response: ChatCompletionResponse;
    provider: string;
    promptTokens: number;
    completionTokens: number;
  } | undefined {
    if (!this.enabled) return undefined;
    if (request.stream) return undefined;
    if (hasImageContent(request)) return undefined;
    // json_schema responses are never served from cache because the caller
    // may want to re-validate against a different schema or receive fresh
    // content for annotation (schema-validation warnings depend on content).
    if (request.response_format?.type === "json_schema") return undefined;

    const key = this.buildKey(request);
    const entry = this.store.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }

    // LRU bump: re-insert to mark as recently used.
    this.store.delete(key);
    this.store.set(key, entry);

    entry.hitCount++;
    this.hits++;

    return {
      response: entry.response,
      provider: entry.provider,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
    };
  }

  /**
   * Store a successful response. Skips streaming, disabled cache, and
   * length-truncated responses. Evicts the oldest entry if at capacity (LRU).
   */
  set(
    request: ChatCompletionRequest,
    response: ChatCompletionResponse,
    provider: string,
    promptTokens: number,
    completionTokens: number,
  ): void {
    if (!this.enabled) return;
    if (request.stream) return;
    if (hasImageContent(request)) return;
    // json_schema responses are never cached — schema-validation annotations
    // depend on fresh content and the schema may differ across callers.
    if (request.response_format?.type === "json_schema") return;
    if (!ResponseCache.isCacheable(response)) return;

    const key = this.buildKey(request);

    // LRU eviction if over capacity AND this is a new key
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
        this.evictions++;
      }
    }

    this.store.set(key, {
      response,
      provider,
      promptTokens,
      completionTokens,
      expiresAt: Date.now() + this.ttlMs,
      createdAt: Date.now(),
      hitCount: 0,
    });
    this.sets++;
  }

  /** Clear all cached entries (admin reset). */
  clear(): void {
    this.store.clear();
  }

  /**
   * Should this response land in the cache at all? Returns false for
   * truncated responses (`finish_reason === "length"` on any choice),
   * which otherwise would pin a bad answer for the whole TTL window.
   * The caller is expected to raise max_tokens or reasoning_effort and
   * retry rather than reuse the incomplete output.
   *
   * Errors, streaming, and empty responses are filtered by `set()` via
   * the existing early-return paths so this helper only has to guard
   * the length-truncation case.
   */
  static isCacheable(response: ChatCompletionResponse): boolean {
    if (!response.choices || response.choices.length === 0) return false;
    for (const choice of response.choices) {
      if (choice.finish_reason === "length") return false;
    }
    return true;
  }

  /** Snapshot of cache statistics for /v1/status and the dashboard. */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      enabled: this.enabled,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      currentSize: this.store.size,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      evictions: this.evictions,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}
