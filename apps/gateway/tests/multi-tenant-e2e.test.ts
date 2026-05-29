import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Express } from "express";
import request from "supertest";
/**
 * End-to-end test of the multi-tenant surface:
 *   - per-identifier rate limiting
 *   - virtual sub-key authentication
 *   - virtual key cap enforcement
 *
 * Boots the real Express app against a fake upstream, with a temp
 * virtual-keys.json pointed at via FREELLM_VIRTUAL_KEYS_PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let upstreamServer: Server;
let upstreamUrl: string;
let tmpDir: string;
let app: Express;

const virtualKeysFile = () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "freellm-mt-test-"));
  const file = path.join(tmpDir, "virtual-keys.json");
  writeFileSync(
    file,
    JSON.stringify({
      keys: [
        {
          id: "sk-freellm-tight-cap-0001",
          label: "tight cap",
          dailyRequestCap: 2,
          allowedModels: ["ollama/llama3"],
        },
        {
          id: "sk-freellm-wide-open-0002",
          label: "wide open",
        },
        {
          id: "sk-freellm-expired-0003",
          label: "expired",
          expiresAt: "2020-01-01T00:00:00Z",
        },
      ],
    }),
  );
  return file;
};

async function startFakeUpstream(): Promise<void> {
  const canned = JSON.stringify({
    id: "chatcmpl-mt",
    object: "chat.completion",
    created: 0,
    model: "llama3",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  });
  upstreamServer = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(canned);
    });
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = upstreamServer.address() as AddressInfo;
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
}

beforeAll(async () => {
  await startFakeUpstream();

  process.env.OLLAMA_BASE_URL = upstreamUrl;
  process.env.OLLAMA_MODELS = "llama3";
  // Master key stays unset so the virtual keys are the only auth source.
  delete process.env.FREELLM_API_KEY;
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
  // Generous identifier limit so these tests do not trip on their own IP bucket.
  process.env.FREELLM_IDENTIFIER_LIMIT = "1000/60000";
  process.env.RATE_LIMIT_RPM = "100000";
  process.env.FREELLM_VIRTUAL_KEYS_PATH = virtualKeysFile();

  // Init the virtual-key singleton BEFORE importing app so auth sees it.
  const { initVirtualKeys } = await import("../src/features/virtual-keys.js");
  initVirtualKeys();

  const mod = await import("../src/app.js");
  app = mod.default;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    upstreamServer.close((err) => (err ? reject(err) : resolve())),
  );
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("E2E: virtual key authentication", () => {
  it("accepts a known virtual key", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer sk-freellm-wide-open-0002")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "ping" }],
      });
    expect(res.status).toBe(200);
  });

  it("rejects a random sk-freellm- token that is not in the file", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer sk-freellm-does-not-exist-9999")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "hi" }],
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
  });

  it("rejects an expired virtual key", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer sk-freellm-expired-0003")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "hi" }],
      });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
  });
});

describe("E2E: virtual key caps", () => {
  it("enforces allowedModels", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer sk-freellm-tight-cap-0001")
      .send({
        model: "free-fast",
        messages: [{ role: "user", content: "hi" }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("model_not_supported");
  });

  it("enforces dailyRequestCap (soft, rolling 24h)", async () => {
    // Fresh tight-cap key is limited to 2 requests in the rolling window.
    // First two succeed, third is 429 virtual_key_cap_reached.
    const body = {
      model: "ollama/llama3",
      messages: [{ role: "user", content: "hi" }],
    };
    const tightKey = "Bearer sk-freellm-tight-cap-0001";

    const r1 = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", tightKey)
      .send(body);
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", tightKey)
      .send(body);
    expect(r2.status).toBe(200);

    const r3 = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", tightKey)
      .send(body);
    expect(r3.status).toBe(429);
    expect(r3.body.error.code).toBe("virtual_key_cap_reached");
  });
});

describe("E2E: identifier rate limit middleware", () => {
  it("echoes the resolved identifier and remaining budget headers", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer sk-freellm-wide-open-0002")
      .set("x-freellm-identifier", "portfolio-user-42")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "hi" }],
      });
    expect(res.status).toBe(200);
    expect(res.headers["x-freellm-identifier"]).toBe("portfolio-user-42");
    expect(res.headers["x-freellm-identifier-remaining"]).toBeDefined();
    expect(res.headers["x-freellm-identifier-reset"]).toBeDefined();
  });

  it("rejects identifiers containing unsafe characters", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer sk-freellm-wide-open-0002")
      .set("x-freellm-identifier", "has spaces")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "hi" }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("treats the literal strings 'undefined' and 'null' as missing", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", "Bearer sk-freellm-wide-open-0002")
      .set("x-freellm-identifier", "undefined")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "hi" }],
      });
    expect(res.status).toBe(200);
    // Falls back to an IP bucket.
    expect(res.headers["x-freellm-identifier"]).toMatch(/^ip:/);
  });
});
