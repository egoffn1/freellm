/**
 * Unit tests for the NIM provider's mapRequest override.
 *
 * These do not hit the real NIM API. They call the protected
 * mapRequest method directly (via a tiny subclass that exposes it) and
 * assert the output shape. The key behavior under test: NIM does not
 * support response_format.type === "json_schema", so the adapter must
 * rewrite it into nvext.guided_json and remove response_format.
 */
import { describe, it, expect } from "vitest";
import { NimProvider } from "../src/providers/nim.js";
import type { ChatCompletionRequest } from "../src/types.js";

// Subclass that lets the test call the protected mapRequest directly.
class ExposedNimProvider extends NimProvider {
  public exposeMapRequest(
    request: ChatCompletionRequest,
  ): ChatCompletionRequest {
    return this.mapRequest(request);
  }
}

function nim() {
  return new ExposedNimProvider();
}

function baseRequest(
  overrides: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest {
  return {
    model: "nim/meta/llama-3.3-70b-instruct",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

const sampleSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
  },
  required: ["name", "age"],
};

describe("NimProvider.mapRequest json_schema translation", () => {
  it("translates json_schema into nvext.guided_json and removes response_format", () => {
    const mapped = nim().exposeMapRequest(
      baseRequest({
        response_format: {
          type: "json_schema",
          json_schema: { name: "person", schema: sampleSchema },
        },
      }),
    );
    expect((mapped as Record<string, unknown>).nvext).toEqual({
      guided_json: sampleSchema,
    });
    expect(mapped.response_format).toBeUndefined();
  });

  it("preserves the schema content exactly (deep equal)", () => {
    const complexSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["id"],
          },
        },
      },
      required: ["items"],
    };
    const mapped = nim().exposeMapRequest(
      baseRequest({
        response_format: {
          type: "json_schema",
          json_schema: { name: "complex", schema: complexSchema },
        },
      }),
    );
    expect((mapped as Record<string, unknown>).nvext).toEqual({
      guided_json: complexSchema,
    });
  });

  it("passes through json_object response_format untouched", () => {
    const mapped = nim().exposeMapRequest(
      baseRequest({
        response_format: { type: "json_object" },
      }),
    );
    expect(mapped.response_format).toEqual({ type: "json_object" });
    expect((mapped as Record<string, unknown>).nvext).toBeUndefined();
  });

  it("passes through requests without response_format untouched", () => {
    const mapped = nim().exposeMapRequest(baseRequest());
    expect(mapped.response_format).toBeUndefined();
    expect((mapped as Record<string, unknown>).nvext).toBeUndefined();
  });
});

describe("NimProvider.mapRequest base behavior preserved", () => {
  it("still strips the 'nim/' prefix from the model name", () => {
    const mapped = nim().exposeMapRequest(
      baseRequest({ model: "nim/meta/llama-3.3-70b-instruct" }),
    );
    expect(mapped.model).toBe("meta/llama-3.3-70b-instruct");
  });

  it("preserves messages, temperature, and other untouched fields", () => {
    const mapped = nim().exposeMapRequest(
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
