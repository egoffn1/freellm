/**
 * End-to-end test: real Express app + real gateway router + fake upstream.
 *
 * Strategy:
 * 1. Spin up a tiny http.Server that impersonates an OpenAI-compatible
 *    upstream. We can flip its mode between "ok" and "rate_limit".
 * 2. Set OLLAMA_BASE_URL to that fake server BEFORE importing the app
 *    (so the singleton gateway picks it up).
 * 3. Hit the app with supertest and assert headers + body shapes.
 *
 * The Ollama provider is convenient because it has no API key requirement
 * and is enabled purely by OLLAMA_BASE_URL + OLLAMA_MODELS being set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import request from "supertest";
import type { Express } from "express";

type UpstreamMode = "ok" | "rate_limit" | "server_error";

interface FakeUpstream {
  server: Server;
  url: string;
  mode: { current: UpstreamMode };
  hits: { count: number };
  close: () => Promise<void>;
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const mode = { current: "ok" as UpstreamMode };
  const hits = { count: 0 };

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      hits.count++;
      // Drain the request body so the connection cleans up.
      req.on("data", () => {});
      req.on("end", () => {
        if (mode.current === "rate_limit") {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
          res.end(JSON.stringify({ error: { message: "fake upstream rate limit" } }));
          return;
        }
        if (mode.current === "server_error") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "fake upstream blew up" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-fake-1",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "llama3",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hello from fake upstream" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    server,
    url,
    mode,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

let upstream: FakeUpstream;
let app: Express;

beforeAll(async () => {
  upstream = await startFakeUpstream();

  // Configure env BEFORE importing the app — the gateway is a module-level
  // singleton that reads env at construction time.
  process.env["OLLAMA_BASE_URL"] = upstream.url;
  process.env["OLLAMA_MODELS"] = "llama3";
  // Disable the per-IP client rate-limit so test bursts aren't blocked.
  process.env["DISABLE_CLIENT_RATELIMIT"] = "true";
  process.env["RATE_LIMIT_RPM"] = "100000";
  process.env["FREELLM_IDENTIFIER_LIMIT"] = "1000/60000";
  // Make sure no real provider keys are present (vitest inherits parent env).
  for (const k of [
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "CEREBRAS_API_KEY",
    "NIM_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_KEY",
    "GITHUB_MODELS_API_KEY",
    "FREELLM_API_KEY",
  ]) {
    delete process.env[k];
  }

  const mod = await import("../src/app.js");
  app = mod.default;
});

afterAll(async () => {
  await upstream.close();
});

describe("E2E: success path sets X-FreeLLM-* headers", () => {
  it("returns 200 with the full transparent-routing header set on a concrete model", async () => {
    upstream.mode.current = "ok";
    const before = upstream.hits.count;

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "ping" }],
      });

    expect(res.status).toBe(200);
    expect(upstream.hits.count).toBe(before + 1);
    expect(res.headers["x-freellm-provider"]).toBe("ollama");
    expect(res.headers["x-freellm-model"]).toBe("ollama/llama3");
    expect(res.headers["x-freellm-requested-model"]).toBe("ollama/llama3");
    expect(res.headers["x-freellm-cached"]).toBe("false");
    expect(res.headers["x-freellm-route-reason"]).toBe("direct");
    expect(res.body.choices[0].message.content).toBe("hello from fake upstream");
  });

  it("marks reason=meta when the request uses a meta-model", async () => {
    upstream.mode.current = "ok";
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "free",
        messages: [{ role: "user", content: "what reason header do I get" }],
      });
    expect(res.status).toBe(200);
    expect(res.headers["x-freellm-requested-model"]).toBe("free");
    expect(res.headers["x-freellm-route-reason"]).toBe("meta");
    // Resolved model should be the concrete ollama default.
    expect(res.headers["x-freellm-model"]).toMatch(/^ollama\//);
  });

  it("flags X-FreeLLM-Cached=true on the second identical request", async () => {
    upstream.mode.current = "ok";
    const before = upstream.hits.count;
    const body = {
      model: "ollama/llama3",
      messages: [{ role: "user", content: "cache me please, deterministic prompt" }],
      temperature: 0,
    };

    const r1 = await request(app).post("/v1/chat/completions").send(body);
    expect(r1.status).toBe(200);
    expect(r1.headers["x-freellm-cached"]).toBe("false");

    const r2 = await request(app).post("/v1/chat/completions").send(body);
    expect(r2.status).toBe(200);
    expect(r2.headers["x-freellm-cached"]).toBe("true");
    expect(r2.headers["x-freellm-route-reason"]).toBe("cache");
    // Only one upstream call total — second was served from cache.
    expect(upstream.hits.count).toBe(before + 1);
  });
});

describe("E2E: strict mode enforcement", () => {
  it("returns 400 when strict mode is combined with a meta-model", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("x-freellm-strict", "true")
      .send({
        model: "free-fast",
        messages: [{ role: "user", content: "no" }],
      });
    expect(res.status).toBe(400);
    // Phase 0 canonical taxonomy — strict mode is in the invalid_request_error bucket.
    expect(res.body.error.type).toBe("invalid_request_error");
    expect(res.body.error.code).toBe("strict_mode_meta_model_forbidden");
    expect(res.body.error.requested_model).toBe("free-fast");
    expect(res.body.error.request_id).toBeTypeOf("string");
  });

  it("does NOT failover when strict and the chosen provider 429s", async () => {
    upstream.mode.current = "rate_limit";
    const before = upstream.hits.count;

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("x-freellm-strict", "true")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "strict 429 test" }],
      });

    // Surfaces the upstream 429 directly with full retry advice.
    expect(res.status).toBe(429);
    expect(res.body.error.type).toBe("rate_limit_error");
    expect(res.body.error.code).toBe("provider_rate_limited");
    expect(res.body.error.provider).toBe("ollama");
    // Exactly one upstream call — no failover.
    expect(upstream.hits.count).toBe(before + 1);
    // Reset for subsequent tests.
    upstream.mode.current = "ok";
  });
});

describe("E2E: actionable 429 bodies", () => {
  it("returns enriched 429 with retry advice when no providers are configured", async () => {
    // We need a fresh app where Ollama isn't configured. Easiest path: hit the
    // running app with a model no provider serves — that triggers the
    // AllProvidersExhaustedError code path with no attempted providers.
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "definitely-not-a-real-model/xyz",
        messages: [{ role: "user", content: "boom" }],
      });

    expect(res.status).toBe(429);
    expect(res.body.error.type).toBe("rate_limit_error");
    expect(res.body.error.code).toBe("all_providers_exhausted");
    // The advice fields are always present (may be empty/null).
    expect(res.body.error).toHaveProperty("retry_after_ms");
    expect(res.body.error).toHaveProperty("providers");
    expect(res.body.error).toHaveProperty("suggestions");
    expect(Array.isArray(res.body.error.providers)).toBe(true);
    expect(Array.isArray(res.body.error.suggestions)).toBe(true);
  });

  it("includes provider hints in the 429 body when a single provider 429s in non-strict mode", async () => {
    upstream.mode.current = "rate_limit";

    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "429 advice test" }],
      });

    // With only one provider configured and it returns 429, all providers
    // are exhausted → enriched 429 from the gateway.
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("all_providers_exhausted");
    const ollamaHint = res.body.error.providers.find((p: { id: string }) => p.id === "ollama");
    expect(ollamaHint).toBeDefined();
    expect(ollamaHint).toMatchObject({
      id: "ollama",
      keys_total: expect.any(Number),
      keys_available: expect.any(Number),
      circuit_state: expect.any(String),
    });
    upstream.mode.current = "ok";
  });
});
