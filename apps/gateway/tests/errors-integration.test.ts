/**
 * Integration tests for Phase 0: error SDK + request-id propagation.
 *
 * We boot a second instance of the Express app in a child vitest with its
 * OWN env config — FREELLM_API_KEY set, no upstream providers — so we can
 * exercise auth and validation error paths without clashing with the
 * provider-backed e2e test.
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

let app: Express;

beforeAll(async () => {
  // Freeze env BEFORE importing the app — the gateway is a module singleton.
  // A fixed API key lets us exercise 401 paths.
  process.env["FREELLM_API_KEY"] = "test-key-for-errors-integration";
  process.env["DISABLE_CLIENT_RATELIMIT"] = "true";
  process.env["RATE_LIMIT_RPM"] = "100000";
  process.env["FREELLM_IDENTIFIER_LIMIT"] = "1000/60000";
  delete process.env["OLLAMA_BASE_URL"];
  delete process.env["OLLAMA_MODELS"];
  for (const k of [
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "CEREBRAS_API_KEY",
    "NIM_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_KEY",
    "GITHUB_MODELS_API_KEY",
  ]) {
    delete process.env[k];
  }

  const mod = await import("../src/app.js");
  app = mod.default;
});

describe("Phase 0: request-id propagation", () => {
  it("assigns an X-Request-Id header on every response", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["x-request-id"]).toBeTypeOf("string");
    expect(res.headers["x-request-id"]!.length).toBeGreaterThan(0);
  });

  it("echoes a client-supplied X-Request-Id when it matches the safe pattern", async () => {
    const res = await request(app).get("/healthz").set("x-request-id", "my-trace-123");
    expect(res.headers["x-request-id"]).toBe("my-trace-123");
  });

  it("rejects inbound X-Request-Id that fails the safe-character pattern", async () => {
    // Space is a valid HTTP header character but fails our stricter regex.
    const res = await request(app).get("/healthz").set("x-request-id", "has spaces");
    expect(res.headers["x-request-id"]).not.toBe("has spaces");
    expect(res.headers["x-request-id"]).toBeTypeOf("string");
    // Expect a freshly-minted UUID shape.
    expect(res.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("rejects inbound X-Request-Id longer than 128 characters", async () => {
    const oversized = "a".repeat(200);
    const res = await request(app).get("/healthz").set("x-request-id", oversized);
    expect(res.headers["x-request-id"]).not.toBe(oversized);
    expect(res.headers["x-request-id"]!.length).toBeLessThanOrEqual(128);
  });

  it("response body request_id matches the X-Request-Id header for error paths", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer test-key-for-errors-integration")
      .set("content-type", "application/json")
      .send({ model: "", messages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.request_id).toBe(res.headers["x-request-id"]);
  });
});

describe("Phase 0: canonical error shape", () => {
  it("400 invalid_request on malformed body", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer test-key-for-errors-integration")
      .set("content-type", "application/json")
      .send({ no_model_here: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request",
    });
    expect(res.body.error.request_id).toBeTypeOf("string");
    expect(res.body.error.issues).toBeInstanceOf(Array);
  });

  it("401 missing_api_key when auth header is absent", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send({ model: "free", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      type: "authentication_error",
      code: "missing_api_key",
    });
    expect(res.body.error.request_id).toBeTypeOf("string");
  });

  it("401 invalid_api_key on bearer mismatch", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer totally-wrong-key")
      .set("content-type", "application/json")
      .send({ model: "free", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
    });
  });

  it("every error response includes type, code, message, request_id", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send({ stray: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toHaveProperty("type");
    expect(res.body.error).toHaveProperty("code");
    expect(res.body.error).toHaveProperty("message");
    expect(res.body.error).toHaveProperty("request_id");
  });
});
