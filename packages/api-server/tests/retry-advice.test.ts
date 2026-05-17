import { describe, it, expect } from "vitest";
import {
  providerRetryAfterMs,
  earliestRetryMs,
  buildRetryAdvice,
  retryAfterSeconds,
} from "../src/routing/retry-advice.js";
import type { ProviderStatusInfo } from "../src/types.js";

type KeySpec = { retryAfterMs: number | null; rateLimited?: boolean };
type ProviderOverrides = Omit<Partial<ProviderStatusInfo>, "keys"> & { keys?: KeySpec[] };

function mkProvider(id: string, opts: ProviderOverrides = {}): ProviderStatusInfo {
  const specs: KeySpec[] = opts.keys ?? [{ retryAfterMs: null, rateLimited: false }];
  const keys = specs.map((k, i) => ({
    index: i,
    rateLimited: k.rateLimited ?? k.retryAfterMs != null,
    requestsInWindow: 0,
    maxRequests: 30,
    retryAfterMs: k.retryAfterMs,
  }));
  const { keys: _omit, ...rest } = opts;
  return {
    id,
    name: id,
    enabled: true,
    circuitBreakerState: "closed",
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    rateLimitedRequests: 0,
    lastError: null,
    lastUsedAt: null,
    models: [`${id}/m`],
    keyCount: keys.length,
    keysAvailable: keys.filter((k) => !k.rateLimited).length,
    keys,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, requestCount: 0 },
    ...rest,
  };
}

describe("providerRetryAfterMs", () => {
  it("returns 0 when at least one key is available", () => {
    const p = mkProvider("groq", {
      keys: [
        { retryAfterMs: 5000, rateLimited: true },
        { retryAfterMs: null, rateLimited: false },
      ],
    });
    expect(providerRetryAfterMs(p)).toBe(0);
  });

  it("returns the minimum cooldown when all keys are blocked", () => {
    const p = mkProvider("gemini", {
      keys: [
        { retryAfterMs: 12_000, rateLimited: true },
        { retryAfterMs: 3_000, rateLimited: true },
        { retryAfterMs: 8_000, rateLimited: true },
      ],
    });
    expect(providerRetryAfterMs(p)).toBe(3_000);
  });

  it("returns null when there are no keys at all", () => {
    const p = mkProvider("ollama", { keys: [] });
    expect(providerRetryAfterMs(p)).toBeNull();
  });

  it("returns null when blocked but cooldowns are unknown", () => {
    const p = mkProvider("mistral", {
      keys: [{ retryAfterMs: null, rateLimited: true }],
    });
    expect(providerRetryAfterMs(p)).toBeNull();
  });
});

describe("earliestRetryMs", () => {
  it("returns 0 if any provider is available right now", () => {
    const ps = [
      mkProvider("a", { keys: [{ retryAfterMs: 9_000, rateLimited: true }] }),
      mkProvider("b", { keys: [{ retryAfterMs: null, rateLimited: false }] }),
    ];
    expect(earliestRetryMs(ps)).toBe(0);
  });

  it("returns the smallest cooldown across blocked providers", () => {
    const ps = [
      mkProvider("a", { keys: [{ retryAfterMs: 9_000, rateLimited: true }] }),
      mkProvider("b", { keys: [{ retryAfterMs: 4_000, rateLimited: true }] }),
      mkProvider("c", { keys: [{ retryAfterMs: 7_000, rateLimited: true }] }),
    ];
    expect(earliestRetryMs(ps)).toBe(4_000);
  });

  it("returns null when no provider gives a deterministic answer", () => {
    const ps = [
      mkProvider("a", { keys: [{ retryAfterMs: null, rateLimited: true }] }),
      mkProvider("b", { keys: [{ retryAfterMs: null, rateLimited: true }] }),
    ];
    expect(earliestRetryMs(ps)).toBeNull();
  });
});

describe("buildRetryAdvice", () => {
  it("orders attempted providers first in hints", () => {
    const ps = [
      mkProvider("groq", { keys: [{ retryAfterMs: 5_000, rateLimited: true }] }),
      mkProvider("gemini", { keys: [{ retryAfterMs: 2_000, rateLimited: true }] }),
      mkProvider("mistral", { keys: [{ retryAfterMs: 8_000, rateLimited: true }] }),
    ];
    const advice = buildRetryAdvice(ps, ["mistral"]);
    expect(advice.providers[0].id).toBe("mistral");
    expect(advice.providers.map((h) => h.id)).toEqual(["mistral", "groq", "gemini"]);
  });

  it("emits the global earliest retry across all providers", () => {
    const ps = [
      mkProvider("groq", { keys: [{ retryAfterMs: 9_000, rateLimited: true }] }),
      mkProvider("gemini", { keys: [{ retryAfterMs: 2_000, rateLimited: true }] }),
    ];
    const advice = buildRetryAdvice(ps, ["groq"]);
    expect(advice.retry_after_ms).toBe(2_000);
  });

  it("includes per-key counts in hints", () => {
    const ps = [
      mkProvider("groq", {
        keys: [
          { retryAfterMs: 1_000, rateLimited: true },
          { retryAfterMs: null, rateLimited: false },
        ],
      }),
    ];
    const advice = buildRetryAdvice(ps, ["groq"]);
    expect(advice.providers[0]).toMatchObject({
      id: "groq",
      keys_available: 1,
      keys_total: 2,
      retry_after_ms: 0,
    });
  });

  it("emits free-fast and free-smart suggestions when meta groups are non-empty", () => {
    const ps = [
      mkProvider("groq", { keys: [{ retryAfterMs: 5_000, rateLimited: true }] }),
      mkProvider("gemini", { keys: [{ retryAfterMs: 2_000, rateLimited: true }] }),
    ];
    const advice = buildRetryAdvice(ps, ["groq", "gemini"]);
    const ids = advice.suggestions.map((s) => s.model);
    expect(ids).toContain("free-fast");
    expect(ids).toContain("free-smart");
  });

  it("skips disabled providers", () => {
    const ps = [
      mkProvider("groq", { enabled: false, keys: [{ retryAfterMs: 1_000, rateLimited: true }] }),
      mkProvider("gemini", { keys: [{ retryAfterMs: 2_000, rateLimited: true }] }),
    ];
    const advice = buildRetryAdvice(ps, ["groq"]);
    expect(advice.providers.find((h) => h.id === "groq")).toBeUndefined();
  });
});

describe("retryAfterSeconds", () => {
  it("rounds milliseconds up to whole seconds with a 1s floor", () => {
    expect(retryAfterSeconds({ retry_after_ms: 0, providers: [], suggestions: [] })).toBe(1);
    expect(retryAfterSeconds({ retry_after_ms: 1, providers: [], suggestions: [] })).toBe(1);
    expect(retryAfterSeconds({ retry_after_ms: 999, providers: [], suggestions: [] })).toBe(1);
    expect(retryAfterSeconds({ retry_after_ms: 1_001, providers: [], suggestions: [] })).toBe(2);
    expect(retryAfterSeconds({ retry_after_ms: 12_000, providers: [], suggestions: [] })).toBe(12);
  });

  it("returns null when retry_after_ms is unknown", () => {
    expect(retryAfterSeconds({ retry_after_ms: null, providers: [], suggestions: [] })).toBeNull();
  });
});
