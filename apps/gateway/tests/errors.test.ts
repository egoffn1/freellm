import { describe, it, expect } from "vitest";
import {
  freellmError,
  FreeLLMError,
  httpStatusFor,
  typeFor,
  isFreeLLMError,
  toBody,
  redactSecrets,
  type ErrorCode,
  type ErrorType,
} from "../src/errors/index.js";

// Enumerate every ErrorCode so the tests serve as an exhaustiveness check.
// Adding a new code forces the test author to update this list.
const ALL_CODES: ErrorCode[] = [
  "invalid_request",
  "strict_mode_meta_model_forbidden",
  "model_not_supported",
  "no_providers_configured",
  "missing_api_key",
  "invalid_api_key",
  "admin_required",
  "provider_not_found",
  "client_rate_limited",
  "identifier_rate_limited",
  "virtual_key_cap_reached",
  "provider_rate_limited",
  "all_providers_exhausted",
  "provider_upstream_error",
  "internal_server_error",
];

describe("httpStatusFor", () => {
  it("returns a status number for every declared code", () => {
    for (const code of ALL_CODES) {
      const s = httpStatusFor(code);
      expect(typeof s).toBe("number");
      expect(s).toBeGreaterThanOrEqual(400);
      expect(s).toBeLessThan(600);
    }
  });

  it("maps 400-category codes to 400", () => {
    expect(httpStatusFor("invalid_request")).toBe(400);
    expect(httpStatusFor("strict_mode_meta_model_forbidden")).toBe(400);
    expect(httpStatusFor("model_not_supported")).toBe(400);
    expect(httpStatusFor("no_providers_configured")).toBe(400);
  });

  it("maps auth codes to 401", () => {
    expect(httpStatusFor("missing_api_key")).toBe(401);
    expect(httpStatusFor("invalid_api_key")).toBe(401);
  });

  it("maps admin_required to 403", () => {
    expect(httpStatusFor("admin_required")).toBe(403);
  });

  it("maps provider_not_found to 404", () => {
    expect(httpStatusFor("provider_not_found")).toBe(404);
  });

  it("maps every rate-limit code to 429", () => {
    expect(httpStatusFor("client_rate_limited")).toBe(429);
    expect(httpStatusFor("identifier_rate_limited")).toBe(429);
    expect(httpStatusFor("virtual_key_cap_reached")).toBe(429);
    expect(httpStatusFor("provider_rate_limited")).toBe(429);
    expect(httpStatusFor("all_providers_exhausted")).toBe(429);
  });

  it("maps provider_upstream_error to 502", () => {
    expect(httpStatusFor("provider_upstream_error")).toBe(502);
  });

  it("maps internal_server_error to 500", () => {
    expect(httpStatusFor("internal_server_error")).toBe(500);
  });
});

describe("typeFor", () => {
  it("returns a type for every declared code", () => {
    for (const code of ALL_CODES) {
      const t = typeFor(code);
      expect(typeof t).toBe("string");
      expect(t.endsWith("_error")).toBe(true);
    }
  });

  it("matches the HTTP status family", () => {
    const pairs: Array<[ErrorCode, ErrorType]> = [
      ["invalid_request", "invalid_request_error"],
      ["missing_api_key", "authentication_error"],
      ["admin_required", "permission_error"],
      ["provider_not_found", "not_found_error"],
      ["all_providers_exhausted", "rate_limit_error"],
      ["provider_upstream_error", "provider_error"],
      ["internal_server_error", "internal_error"],
    ];
    for (const [code, type] of pairs) {
      expect(typeFor(code)).toBe(type);
    }
  });
});

describe("freellmError factory", () => {
  it("returns a FreeLLMError instance", () => {
    const err = freellmError({ code: "invalid_request", message: "bad" });
    expect(err).toBeInstanceOf(FreeLLMError);
    expect(err.code).toBe("invalid_request");
    expect(err.message).toBe("bad");
  });

  it("stores context fields (excluding code/message) on the instance", () => {
    const err = freellmError({
      code: "provider_rate_limited",
      message: "slow down",
      provider: "groq",
      retry_after_ms: 3000,
    });
    expect(err.context.provider).toBe("groq");
    expect(err.context.retry_after_ms).toBe(3000);
    // code/message are first-class, NOT duplicated in context
    expect(err.context).not.toHaveProperty("code");
    expect(err.context).not.toHaveProperty("message");
  });
});

describe("isFreeLLMError", () => {
  it("discriminates FreeLLMError from vanilla Error", () => {
    expect(isFreeLLMError(freellmError({ code: "invalid_request", message: "x" }))).toBe(true);
    expect(isFreeLLMError(new Error("x"))).toBe(false);
    expect(isFreeLLMError(new TypeError("x"))).toBe(false);
    expect(isFreeLLMError(null)).toBe(false);
    expect(isFreeLLMError(undefined)).toBe(false);
    expect(isFreeLLMError("string")).toBe(false);
    expect(isFreeLLMError({ code: "invalid_request" })).toBe(false);
  });
});

describe("toBody", () => {
  it("includes type, code, message, request_id on every output", () => {
    const err = freellmError({ code: "invalid_request", message: "bad body" });
    const body = toBody(err, "req-xyz");
    expect(body.error).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request",
      message: "bad body",
      request_id: "req-xyz",
    });
  });

  it("forwards discriminated context fields", () => {
    const err = freellmError({
      code: "all_providers_exhausted",
      message: "nope",
      retry_after_ms: 7000,
      providers: [
        {
          id: "groq",
          retry_after_ms: 7000,
          keys_available: 0,
          keys_total: 1,
          circuit_state: "closed",
        },
      ],
      suggestions: [{ model: "free-smart", available_in_ms: 0 }],
    });
    const body = toBody(err, "req-1");
    expect(body.error.retry_after_ms).toBe(7000);
    expect(body.error.providers).toHaveLength(1);
    expect(body.error.suggestions).toHaveLength(1);
  });

  it("forwards provider + requested_model context", () => {
    const err = freellmError({
      code: "strict_mode_meta_model_forbidden",
      message: "no meta in strict",
      requested_model: "free",
    });
    const body = toBody(err, "req-2");
    expect(body.error.requested_model).toBe("free");
  });

  it("falls back to internal_server_error for unknown input", () => {
    const body = toBody(new Error("mystery"), "req-3");
    expect(body.error.type).toBe("internal_error");
    expect(body.error.code).toBe("internal_server_error");
    expect(body.error.request_id).toBe("req-3");
  });

  it("falls back to internal_server_error for non-Error input", () => {
    expect(toBody("hello", "req-4").error.code).toBe("internal_server_error");
    expect(toBody(null, "req-5").error.code).toBe("internal_server_error");
    expect(toBody(undefined, "req-6").error.code).toBe("internal_server_error");
  });

  it("uses 'unknown' when request_id is empty", () => {
    const err = freellmError({ code: "invalid_request", message: "x" });
    expect(toBody(err, "").error.request_id).toBe("unknown");
  });
});

describe("redactSecrets", () => {
  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer sk-abc123xyz")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts known API-key prefixes", () => {
    expect(redactSecrets("key is gsk_AbCdEfGhIjKlMnOpQrStUvWx ok")).toContain("[REDACTED_KEY]");
    expect(redactSecrets("AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz")).toContain("[REDACTED_KEY]");
  });

  it("redacts long hex sequences (likely secrets)", () => {
    const hex = "a".repeat(40);
    expect(redactSecrets(`token=${hex}`)).toBe("token=[REDACTED_HEX]");
  });

  it("leaves normal text untouched", () => {
    expect(redactSecrets("invalid model name: free-fast")).toBe("invalid model name: free-fast");
  });
});
