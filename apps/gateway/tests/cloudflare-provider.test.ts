/**
 * Unit tests for the Cloudflare Workers AI provider.
 *
 * These do not hit the real Cloudflare API. They exercise the protected
 * getApiKeys / mapRequest methods directly (via a tiny subclass that
 * exposes them) and assert the env-gated enablement and prefix-stripping
 * behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CloudflareProvider } from "../src/providers/cloudflare.js";
import type { ChatCompletionRequest } from "../src/types.js";

// Subclass that lets the test call protected methods directly.
class ExposedCloudflareProvider extends CloudflareProvider {
  public exposeGetApiKeys(): string[] {
    return this.getApiKeys();
  }
  public exposeMapRequest(
    request: ChatCompletionRequest,
  ): ChatCompletionRequest {
    return this.mapRequest(request);
  }
}

function cf() {
  return new ExposedCloudflareProvider();
}

function baseRequest(
  overrides: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest {
  return {
    model: "cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

// Save and restore env vars so these tests don't leak state into any
// other test file. Both vars get cleared at the start of each test and
// restored to their original values after.
let savedAccountId: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
  savedAccountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  savedApiKey = process.env["CLOUDFLARE_API_KEY"];
  delete process.env["CLOUDFLARE_ACCOUNT_ID"];
  delete process.env["CLOUDFLARE_API_KEY"];
});

afterEach(() => {
  if (savedAccountId === undefined) {
    delete process.env["CLOUDFLARE_ACCOUNT_ID"];
  } else {
    process.env["CLOUDFLARE_ACCOUNT_ID"] = savedAccountId;
  }
  if (savedApiKey === undefined) {
    delete process.env["CLOUDFLARE_API_KEY"];
  } else {
    process.env["CLOUDFLARE_API_KEY"] = savedApiKey;
  }
});

describe("CloudflareProvider.getApiKeys env gating", () => {
  it("returns empty when CLOUDFLARE_ACCOUNT_ID is unset (even if API key is set)", () => {
    process.env["CLOUDFLARE_API_KEY"] = "sk-test";
    expect(cf().exposeGetApiKeys()).toEqual([]);
  });

  it("returns empty when CLOUDFLARE_API_KEY is unset (even if account id is set)", () => {
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "acc-123";
    expect(cf().exposeGetApiKeys()).toEqual([]);
  });

  it("returns parsed keys when both env vars are set", () => {
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "acc-123";
    process.env["CLOUDFLARE_API_KEY"] = "sk-test";
    expect(cf().exposeGetApiKeys()).toEqual(["sk-test"]);
  });

  it("supports comma-separated multi-key rotation", () => {
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "acc-123";
    process.env["CLOUDFLARE_API_KEY"] = "a,b,c";
    expect(cf().exposeGetApiKeys()).toEqual(["a", "b", "c"]);
  });
});

describe("CloudflareProvider.baseUrl", () => {
  it("returns the Cloudflare OpenAI-compat URL scoped to the configured account id", () => {
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "acc-123";
    expect(cf().baseUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc-123/ai/v1",
    );
  });
});

describe("CloudflareProvider.isEnabled", () => {
  it("returns false when CLOUDFLARE_ACCOUNT_ID is missing", () => {
    process.env["CLOUDFLARE_API_KEY"] = "sk-test";
    expect(cf().isEnabled()).toBe(false);
  });

  it("returns true when both env vars are set", () => {
    process.env["CLOUDFLARE_ACCOUNT_ID"] = "acc-123";
    process.env["CLOUDFLARE_API_KEY"] = "sk-test";
    expect(cf().isEnabled()).toBe(true);
  });
});

describe("CloudflareProvider.mapRequest", () => {
  it("strips the 'cloudflare/' prefix and leaves the '@cf/...' model id intact", () => {
    const mapped = cf().exposeMapRequest(
      baseRequest({ model: "cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
    );
    expect(mapped.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("preserves messages, temperature, tools, and other untouched fields", () => {
    const tools = [
      {
        type: "function" as const,
        function: { name: "echo", parameters: { type: "object" } },
      },
    ];
    const mapped = cf().exposeMapRequest(
      baseRequest({
        temperature: 0.7,
        top_p: 0.9,
        tools,
        messages: [{ role: "user", content: "test" }],
      }),
    );
    expect(mapped.temperature).toBe(0.7);
    expect(mapped.top_p).toBe(0.9);
    expect(mapped.tools).toEqual(tools);
    expect(mapped.messages).toEqual([{ role: "user", content: "test" }]);
  });
});

describe("CloudflareProvider catalog", () => {
  it("has exactly 6 models and every entry is tagged with provider 'cloudflare'", () => {
    const models = new CloudflareProvider().models;
    expect(models).toHaveLength(6);
    for (const m of models) {
      expect(m.provider).toBe("cloudflare");
    }
  });

  it("lists every model id with the 'cloudflare/@cf/' prefix", () => {
    const models = new CloudflareProvider().models;
    for (const m of models) {
      expect(m.id.startsWith("cloudflare/@cf/")).toBe(true);
    }
  });
});
