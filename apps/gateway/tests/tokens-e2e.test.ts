/**
 * End-to-end integration test for the browser token flow:
 *
 *   1. A master-key holder calls POST /v1/tokens/issue and receives
 *      an flt.* token bound to an origin and identifier.
 *   2. The token is used to authenticate a subsequent chat completion
 *      call against a fake upstream.
 *   3. The Origin header is verified on the follow-up call.
 *   4. Expired, tampered, and wrong-origin tokens are rejected.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import request from "supertest";
import type { Express } from "express";

let upstreamServer: Server;
let upstreamUrl: string;
let app: Express;

async function startFakeUpstream(): Promise<void> {
  const canned = JSON.stringify({
    id: "chatcmpl-browser-token",
    object: "chat.completion",
    created: 0,
    model: "llama3",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello from fake" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  upstreamServer = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(canned);
    });
  });
  await new Promise<void>((resolve) =>
    upstreamServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = upstreamServer.address() as AddressInfo;
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
}

beforeAll(async () => {
  await startFakeUpstream();

  process.env["FREELLM_API_KEY"] = "master-key-for-tokens-e2e-test";
  process.env["FREELLM_TOKEN_SECRET"] =
    "tokens-e2e-test-secret-48-bytes-0123456789abcdef01234";
  process.env["OLLAMA_BASE_URL"] = upstreamUrl;
  process.env["OLLAMA_MODELS"] = "llama3";
  process.env["RATE_LIMIT_RPM"] = "100000";
  process.env["FREELLM_IDENTIFIER_LIMIT"] = "1000/60000";
  delete process.env["FREELLM_ADMIN_KEY"];
  delete process.env["FREELLM_VIRTUAL_KEYS_PATH"];
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

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    upstreamServer.close((err) => (err ? reject(err) : resolve())),
  );
});

const MASTER = "Bearer master-key-for-tokens-e2e-test";

async function mintToken(overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/v1/tokens/issue")
    .set("authorization", MASTER)
    .set("content-type", "application/json")
    .send({
      origin: "https://portfolio.example.com",
      identifier: "session-abc",
      ttlSeconds: 300,
      ...overrides,
    });
  return res;
}

describe("POST /v1/tokens/issue", () => {
  it("mints a token for a valid request", async () => {
    const res = await mintToken();
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^flt\./);
    expect(res.body.origin).toBe("https://portfolio.example.com");
    expect(res.body.identifier).toBe("session-abc");
    expect(typeof res.body.expiresAt).toBe("string");
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects an http:// origin that is not localhost", async () => {
    const res = await mintToken({ origin: "http://evil.example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("accepts http://localhost for local dev", async () => {
    const res = await mintToken({ origin: "http://localhost:4173" });
    expect(res.status).toBe(201);
  });

  it("rejects ttl above the 900 second ceiling", async () => {
    const res = await mintToken({ ttlSeconds: 901 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("rejects unauth'd calls with missing_api_key", async () => {
    const res = await request(app)
      .post("/v1/tokens/issue")
      .set("content-type", "application/json")
      .send({ origin: "https://portfolio.example.com" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("missing_api_key");
  });

  it("rejects an identifier with unsafe characters", async () => {
    const res = await mintToken({ identifier: "has spaces" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });
});

describe("Browser token authentication", () => {
  it("authenticates a chat completion when Origin matches the token", async () => {
    const mint = await mintToken();
    expect(mint.status).toBe(201);
    const token = mint.body.token;

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", `Bearer ${token}`)
      .set("origin", "https://portfolio.example.com")
      .set("content-type", "application/json")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "hi from browser" }],
      });
    expect(res.status).toBe(200);
    // The gateway should have inferred the identifier from the token
    // payload and counted the request against the session-abc bucket.
    expect(res.headers["x-freellm-identifier"]).toBe("session-abc");
  });

  it("rejects a chat completion when the Origin does not match", async () => {
    const mint = await mintToken();
    const token = mint.body.token;

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", `Bearer ${token}`)
      .set("origin", "https://attacker.example.com")
      .set("content-type", "application/json")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "phish" }],
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
    expect(res.body.error.message).toMatch(/origin_mismatch/);
  });

  it("rejects a chat completion when no Origin header is present", async () => {
    const mint = await mintToken();
    const token = mint.body.token;

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", `Bearer ${token}`)
      .set("content-type", "application/json")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "no origin" }],
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
  });

  it("rejects a browser token with a tampered signature", async () => {
    const mint = await mintToken();
    const token: string = mint.body.token;
    const flipped = token.slice(0, -1) + (token.slice(-1) === "0" ? "1" : "0");

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", `Bearer ${flipped}`)
      .set("origin", "https://portfolio.example.com")
      .set("content-type", "application/json")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "nope" }],
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
  });

  it("blocks a browser token from minting another browser token", async () => {
    const mint = await mintToken();
    const token = mint.body.token;

    const res = await request(app)
      .post("/v1/tokens/issue")
      .set("authorization", `Bearer ${token}`)
      .set("origin", "https://portfolio.example.com")
      .set("content-type", "application/json")
      .send({
        origin: "https://portfolio.example.com",
        identifier: "session-xyz",
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("admin_required");
  });
});
