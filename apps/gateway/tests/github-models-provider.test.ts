/**
 * Unit tests for the GitHub Models provider.
 *
 * These do not hit the real GitHub Models API. They call protected methods
 * directly (via a small subclass that exposes them) and assert env-var
 * handling, the base URL, model catalog shape, and mapRequest behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubModelsProvider } from "../src/providers/github.js";
import type { ChatCompletionRequest } from "../src/types.js";

// Subclass that exposes protected methods for direct testing.
class ExposedGitHubModelsProvider extends GitHubModelsProvider {
  public exposeGetApiKeys(): string[] {
    return this.getApiKeys();
  }
  public exposeMapRequest(request: ChatCompletionRequest): ChatCompletionRequest {
    return this.mapRequest(request);
  }
}

function provider() {
  return new ExposedGitHubModelsProvider();
}

function baseRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "github/openai/gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

// Preserve and restore env vars across tests so they don't leak state.
const ENV_KEYS = ["GITHUB_MODELS_API_KEY", "GITHUB_TOKEN", "GITHUB_API_KEY"] as const;

describe("GitHubModelsProvider env var handling", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it("returns empty when GITHUB_MODELS_API_KEY is unset", () => {
    expect(provider().exposeGetApiKeys()).toEqual([]);
  });

  it("returns a single key when GITHUB_MODELS_API_KEY is a single token", () => {
    process.env.GITHUB_MODELS_API_KEY = "ghp_single_token";
    expect(provider().exposeGetApiKeys()).toEqual(["ghp_single_token"]);
  });

  it("supports comma-separated multi-key rotation", () => {
    process.env.GITHUB_MODELS_API_KEY = "tok1,tok2,tok3";
    expect(provider().exposeGetApiKeys()).toEqual(["tok1", "tok2", "tok3"]);
  });

  it("trims whitespace and drops empty entries", () => {
    process.env.GITHUB_MODELS_API_KEY = "  tok1 , ,tok2,   ,tok3  ";
    expect(provider().exposeGetApiKeys()).toEqual(["tok1", "tok2", "tok3"]);
  });

  it("does NOT read GITHUB_TOKEN or GITHUB_API_KEY", () => {
    // Regression guard: these env vars collide with standard dotfile/CI
    // conventions and must not be picked up by this provider.
    process.env.GITHUB_TOKEN = "should_not_be_read";
    process.env.GITHUB_API_KEY = "also_should_not_be_read";
    expect(provider().exposeGetApiKeys()).toEqual([]);
  });

  it("isEnabled() returns false when env var is missing", () => {
    expect(provider().isEnabled()).toBe(false);
  });

  it("isEnabled() returns true when env var is set to a non-empty value", () => {
    process.env.GITHUB_MODELS_API_KEY = "ghp_any_value";
    expect(provider().isEnabled()).toBe(true);
  });
});

describe("GitHubModelsProvider baseUrl", () => {
  it("is the new models.github.ai/inference endpoint exactly", () => {
    expect(provider().baseUrl).toBe("https://models.github.ai/inference");
  });
});

describe("GitHubModelsProvider.mapRequest", () => {
  it("strips the 'github/' prefix and leaves 'openai/gpt-4o-mini' intact", () => {
    const mapped = provider().exposeMapRequest(baseRequest({ model: "github/openai/gpt-4o-mini" }));
    expect(mapped.model).toBe("openai/gpt-4o-mini");
  });

  it("preserves messages, temperature, and other fields", () => {
    const mapped = provider().exposeMapRequest(
      baseRequest({
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 500,
        messages: [{ role: "user", content: "test" }],
      }),
    );
    expect(mapped.temperature).toBe(0.7);
    expect(mapped.top_p).toBe(0.9);
    expect(mapped.max_tokens).toBe(500);
    expect(mapped.messages).toEqual([{ role: "user", content: "test" }]);
  });
});

describe("GitHubModelsProvider catalog", () => {
  it("has exactly 7 models", () => {
    expect(new GitHubModelsProvider().models).toHaveLength(7);
  });

  it("all catalog ids start with 'github/'", () => {
    const ids = new GitHubModelsProvider().models.map((m) => m.id);
    for (const id of ids) {
      expect(id.startsWith("github/")).toBe(true);
    }
  });

  it("every model has provider: 'github'", () => {
    for (const m of new GitHubModelsProvider().models) {
      expect(m.provider).toBe("github");
    }
  });
});
