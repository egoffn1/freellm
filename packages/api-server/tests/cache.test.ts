/**
 * Unit tests for the response cache's two anti-poisoning rules:
 *
 *   1. Length-truncated responses must never be cached. One unlucky
 *      request that hits max_tokens should not pin a short answer for
 *      the whole TTL window.
 *
 *   2. The cache key must discriminate every request field that can
 *      change the response shape. Two requests with the same prompt
 *      but different tools / response_format / reasoning_effort must
 *      live in different cache entries.
 *
 * Both rules regressed from gaps in the v1.4 cache design that surfaced
 * when Gemini 2.5's reasoning budget started truncating responses and
 * the cache pinned the bad output.
 */
import { describe, it, expect } from "vitest";
import { ResponseCache } from "../src/routing/cache.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "../src/types.js";

function responseWith(finishReason: string | null, content = "ok"): ChatCompletionResponse {
  return {
    id: "test",
    object: "chat.completion",
    created: 0,
    model: "llama3",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function requestWith(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "free-fast",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

describe("ResponseCache.isCacheable", () => {
  it("is true for a naturally-finished response", () => {
    expect(ResponseCache.isCacheable(responseWith("stop"))).toBe(true);
  });

  it("is true for a tool_calls finish reason", () => {
    expect(ResponseCache.isCacheable(responseWith("tool_calls"))).toBe(true);
  });

  it("is false for a length-truncated response", () => {
    expect(ResponseCache.isCacheable(responseWith("length"))).toBe(false);
  });

  it("is false for an empty choices array", () => {
    const empty: ChatCompletionResponse = {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "llama3",
      choices: [],
    };
    expect(ResponseCache.isCacheable(empty)).toBe(false);
  });

  it("is false if ANY choice hit length (multi-choice responses)", () => {
    const mixed: ChatCompletionResponse = {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "llama3",
      choices: [
        { index: 0, message: { role: "assistant", content: "full" }, finish_reason: "stop" },
        { index: 1, message: { role: "assistant", content: "trunc" }, finish_reason: "length" },
      ],
    };
    expect(ResponseCache.isCacheable(mixed)).toBe(false);
  });
});

describe("ResponseCache.set skips uncacheable responses", () => {
  it("does not store a finish_reason=length response", () => {
    const cache = new ResponseCache();
    const req = requestWith();
    cache.set(req, responseWith("length"), "groq", 10, 10);
    expect(cache.get(req)).toBeUndefined();
    expect(cache.getStats().sets).toBe(0);
  });

  it("does store a finish_reason=stop response", () => {
    const cache = new ResponseCache();
    const req = requestWith();
    cache.set(req, responseWith("stop"), "groq", 10, 10);
    const hit = cache.get(req);
    expect(hit).toBeDefined();
    expect(hit?.provider).toBe("groq");
    expect(cache.getStats().sets).toBe(1);
  });
});

describe("ResponseCache key discrimination", () => {
  // Helper: store a marker response under `req`, then see if looking up
  // `other` returns the same one. A hit means the keys collided.
  function keysCollide(req: ChatCompletionRequest, other: ChatCompletionRequest): boolean {
    const cache = new ResponseCache();
    cache.set(req, responseWith("stop", "A"), "groq", 1, 1);
    const hit = cache.get(other);
    return hit !== undefined;
  }

  it("identical requests share a cache entry", () => {
    const a = requestWith({ temperature: 0.5 });
    const b = requestWith({ temperature: 0.5 });
    expect(keysCollide(a, b)).toBe(true);
  });

  it("different tools arrays produce different keys", () => {
    const a = requestWith({
      tools: [
        { type: "function", function: { name: "get_weather" } },
      ],
    });
    const b = requestWith({
      tools: [
        { type: "function", function: { name: "get_time" } },
      ],
    });
    expect(keysCollide(a, b)).toBe(false);
  });

  it("a request with tools does not collide with one without", () => {
    const a = requestWith({
      tools: [
        { type: "function", function: { name: "get_weather" } },
      ],
    });
    const b = requestWith();
    expect(keysCollide(a, b)).toBe(false);
  });

  it("different tool_choice values produce different keys", () => {
    const a = requestWith({ tool_choice: "auto" });
    const b = requestWith({ tool_choice: "required" });
    expect(keysCollide(a, b)).toBe(false);
  });

  it("different response_format values produce different keys", () => {
    const a = requestWith({ response_format: { type: "text" } });
    const b = requestWith({ response_format: { type: "json_object" } });
    expect(keysCollide(a, b)).toBe(false);
  });

  it("different reasoning_effort values produce different keys", () => {
    const a = requestWith({ reasoning_effort: "low" });
    const b = requestWith({ reasoning_effort: "high" });
    expect(keysCollide(a, b)).toBe(false);
  });

  it("different max_completion_tokens values produce different keys", () => {
    const a = requestWith({ max_completion_tokens: 100 });
    const b = requestWith({ max_completion_tokens: 1000 });
    expect(keysCollide(a, b)).toBe(false);
  });

  it("different seed values produce different keys", () => {
    const a = requestWith({ seed: 42 });
    const b = requestWith({ seed: 100 });
    expect(keysCollide(a, b)).toBe(false);
  });

  it("different presence/frequency penalty values produce different keys", () => {
    const a = requestWith({ presence_penalty: 0.5 });
    const b = requestWith({ presence_penalty: 1.5 });
    expect(keysCollide(a, b)).toBe(false);
  });
});
