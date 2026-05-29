import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import request from "supertest";
/**
 * Tests for the X-FreeLLM-Warning: json-possibly-truncated header.
 *
 * Uses a fake upstream whose finish_reason is configurable per-request
 * so each test can independently verify the header logic.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type FinishReason = "stop" | "length";

interface FakeUpstream {
  server: Server;
  url: string;
  finishReason: { current: FinishReason };
  close: () => Promise<void>;
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const finishReason = { current: "stop" as FinishReason };

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-trunc-1",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "llama3",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"partial": true' },
                finish_reason: finishReason.current,
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
    finishReason,
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

  process.env.OLLAMA_BASE_URL = upstream.url;
  process.env.OLLAMA_MODELS = "llama3";
  process.env.DISABLE_CLIENT_RATELIMIT = "true";
  process.env.RATE_LIMIT_RPM = "100000";
  process.env.FREELLM_IDENTIFIER_LIMIT = "1000/60000";
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

describe("JSON truncation detection header", () => {
  it("sets X-FreeLLM-Warning when json_object + finish_reason=length", async () => {
    upstream.finishReason.current = "length";
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "give me json" }],
        response_format: { type: "json_object" },
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-freellm-warning"]).toBe("json-possibly-truncated");
  });

  it("does NOT set X-FreeLLM-Warning when json_object + finish_reason=stop", async () => {
    upstream.finishReason.current = "stop";
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "give me json" }],
        response_format: { type: "json_object" },
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-freellm-warning"]).toBeUndefined();
  });

  it("does NOT set X-FreeLLM-Warning when no response_format + finish_reason=length", async () => {
    upstream.finishReason.current = "length";
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "just text" }],
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-freellm-warning"]).toBeUndefined();
  });

  it("sets X-FreeLLM-Warning when json_schema + finish_reason=length", async () => {
    upstream.finishReason.current = "length";
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "give me structured json" }],
        response_format: {
          type: "json_schema",
          json_schema: { schema: { type: "object" } },
        },
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-freellm-warning"]).toContain("json-possibly-truncated");
  });
});
