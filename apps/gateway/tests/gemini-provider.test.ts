/**
 * Unit tests for the Gemini provider's mapRequest override.
 *
 * These do not hit the real Gemini API. They call the protected
 * mapRequest method directly (via a tiny subclass that exposes it) and
 * assert the output shape. See tests/router.test.ts for the end-to-end
 * flow through the router, and scripts ran against the real gateway
 * for the empirical proof that the per-model reasoning_effort default
 * actually fixes the truncation.
 */
import { describe, expect, it } from "vitest";
import { GeminiProvider, defaultReasoningEffortFor } from "../src/providers/gemini.js";
import type { ChatCompletionRequest } from "../src/types.js";

// Subclass that lets the test call the protected mapRequest directly.
class ExposedGeminiProvider extends GeminiProvider {
  public exposeMapRequest(request: ChatCompletionRequest): ChatCompletionRequest {
    return this.mapRequest(request);
  }
}

function gemini() {
  return new ExposedGeminiProvider();
}

function baseRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "gemini/gemini-2.5-flash",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

describe("defaultReasoningEffortFor", () => {
  it("returns 'none' for gemini-2.5-flash (model accepts zero thinking budget)", () => {
    expect(defaultReasoningEffortFor("gemini-2.5-flash")).toBe("none");
  });

  it("returns 'low' for gemini-2.5-pro (model rejects 'none' with HTTP 400)", () => {
    expect(defaultReasoningEffortFor("gemini-2.5-pro")).toBe("low");
  });

  it("returns 'low' as a conservative fallback for unknown model ids", () => {
    expect(defaultReasoningEffortFor("future-reasoning-model")).toBe("low");
    expect(defaultReasoningEffortFor("")).toBe("low");
  });
});

describe("GeminiProvider.mapRequest reasoning_effort default", () => {
  it("injects 'none' on gemini-2.5-flash when the caller did not set one", () => {
    const mapped = gemini().exposeMapRequest(
      baseRequest({ model: "gemini/gemini-2.5-flash", max_tokens: 1000 }),
    );
    expect(mapped.reasoning_effort).toBe("none");
  });

  it("injects 'low' on gemini-2.5-pro when the caller did not set one", () => {
    const mapped = gemini().exposeMapRequest(
      baseRequest({ model: "gemini/gemini-2.5-pro", max_tokens: 1000 }),
    );
    expect(mapped.reasoning_effort).toBe("low");
  });

  it("keeps the caller's reasoning_effort if they explicitly set one", () => {
    const mapped = gemini().exposeMapRequest(
      baseRequest({ reasoning_effort: "high", max_tokens: 1000 }),
    );
    expect(mapped.reasoning_effort).toBe("high");
  });

  it("respects an explicit 'none' from the caller on 2.5-pro (caller accepts the upstream 400)", () => {
    const mapped = gemini().exposeMapRequest(
      baseRequest({
        model: "gemini/gemini-2.5-pro",
        reasoning_effort: "none",
        max_tokens: 1000,
      }),
    );
    expect(mapped.reasoning_effort).toBe("none");
  });
});

describe("GeminiProvider catalog", () => {
  it("does not list the deprecated 2.0-flash models", () => {
    const ids = new GeminiProvider().models.map((m) => m.id);
    expect(ids).not.toContain("gemini/gemini-2.0-flash");
    expect(ids).not.toContain("gemini/gemini-2.0-flash-lite");
  });

  it("lists the 2.5 family", () => {
    const ids = new GeminiProvider().models.map((m) => m.id);
    expect(ids).toContain("gemini/gemini-2.5-flash");
    expect(ids).toContain("gemini/gemini-2.5-pro");
  });
});

describe("GeminiProvider.mapRequest max_completion_tokens normalization", () => {
  // Gemini OpenAI-compat returns HTTP 400 "max_tokens and
  // max_completion_tokens cannot both be set" when both are present on
  // the outgoing request, so the adapter must carry exactly one. All
  // paths normalize onto max_completion_tokens and delete max_tokens.

  it("lifts max_tokens into max_completion_tokens and drops max_tokens", () => {
    const mapped = gemini().exposeMapRequest(baseRequest({ max_tokens: 1000 }));
    expect(mapped.max_completion_tokens).toBe(1000);
    expect(mapped.max_tokens).toBeUndefined();
  });

  it("keeps max_completion_tokens untouched when only that field is set", () => {
    const mapped = gemini().exposeMapRequest(baseRequest({ max_completion_tokens: 800 }));
    expect(mapped.max_completion_tokens).toBe(800);
    expect(mapped.max_tokens).toBeUndefined();
  });

  it("prefers explicit max_completion_tokens when the caller sent both", () => {
    const mapped = gemini().exposeMapRequest(
      baseRequest({ max_tokens: 500, max_completion_tokens: 800 }),
    );
    expect(mapped.max_completion_tokens).toBe(800);
    expect(mapped.max_tokens).toBeUndefined();
  });

  it("leaves both undefined when the caller sent neither", () => {
    const mapped = gemini().exposeMapRequest(baseRequest());
    expect(mapped.max_tokens).toBeUndefined();
    expect(mapped.max_completion_tokens).toBeUndefined();
  });
});

describe("GeminiProvider.mapRequest base behavior preserved", () => {
  it("still strips the 'gemini/' prefix from the model name", () => {
    const mapped = gemini().exposeMapRequest(baseRequest({ model: "gemini/gemini-2.5-flash" }));
    expect(mapped.model).toBe("gemini-2.5-flash");
  });

  it("preserves messages, temperature, and other untouched fields", () => {
    const mapped = gemini().exposeMapRequest(
      baseRequest({
        temperature: 0.7,
        top_p: 0.9,
        messages: [{ role: "user", content: "test" }],
      }),
    );
    expect(mapped.temperature).toBe(0.7);
    expect(mapped.top_p).toBe(0.9);
    expect(mapped.messages).toEqual([{ role: "user", content: "test" }]);
  });
});
