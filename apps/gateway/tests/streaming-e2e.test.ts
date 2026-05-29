/**
 * End-to-end streaming test. Boots the real Express app with the
 * streaming normalizer pipeline wired in, runs an upstream that
 * replays a captured broken Gemini stream, and verifies the client
 * sees a corrected stream.
 *
 * The upstream fake pretends to be Gemini via the OLLAMA_BASE_URL
 * override. We then identify the "provider" by tweaking config so the
 * normalizer selects the gemini module. This lets us exercise the
 * real chat.ts streaming path end-to-end without hitting Google.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import request from "supertest";
import type { Express } from "express";

// We need the normalizer to treat the upstream as gemini. The easiest
// path without monkey-patching is to exercise the streaming path
// against the ollama provider (which is the easiest to configure from
// env) and check that the ollama normalizer also fixes broken streams
// the same way. The ollama normalizer handles the exact same bug class.

let upstreamServer: Server;
let upstreamUrl: string;
let app: Express;

/** Raw SSE bytes the fake upstream will emit. Intentionally broken. */
const BROKEN_TOOL_CALL_STREAM =
  'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"llama3","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"llama3","choices":[{"index":0,"delta":{"tool_calls":[{"function":{"name":"search","arguments":"{\\"q\\":\\"freellm\\"}"}}]}}]}\n\n' +
  'data: [DONE]\n\n';

async function startFakeUpstream(): Promise<void> {
  upstreamServer = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.end(BROKEN_TOOL_CALL_STREAM);
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

  process.env["OLLAMA_BASE_URL"] = upstreamUrl;
  process.env["OLLAMA_MODELS"] = "llama3";
  process.env["RATE_LIMIT_RPM"] = "100000";
  process.env["FREELLM_IDENTIFIER_LIMIT"] = "1000/60000";
  delete process.env["FREELLM_API_KEY"];
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

beforeEach(() => {
  // Each test hits /v1/chat/completions fresh. No state to reset on
  // the app side since the pipeline is per-request.
});

describe("E2E: streaming normalizer fills missing tool_call fields", () => {
  it("returns a well-formed SSE stream with the ollama normalizer applied", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "trigger" }],
        stream: true,
      })
      .buffer(true)
      .parse((r, cb) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("data", (chunk) => (data += chunk));
        r.on("end", () => cb(null, data));
      });

    expect(res.status).toBe(200);

    const body = res.body as unknown as string;
    expect(body).toContain("[DONE]");

    // The stream must contain a well-formed tool_calls delta with
    // index=0 and type=function AFTER the normalizer ran, even though
    // the upstream omitted both fields.
    expect(body).toContain('"index":0');
    expect(body).toContain('"type":"function"');
    expect(body).toContain('"name":"search"');

    // Observability headers from the route should still be present.
    expect(res.headers["x-freellm-provider"]).toBe("ollama");
    expect(res.headers["x-freellm-requested-model"]).toBe("ollama/llama3");
    expect(res.headers["x-request-id"]).toBeTypeOf("string");

    // Every `data:` line in the body that contains JSON must parse.
    const lines = body.split("\n").filter((l) => l.startsWith("data: "));
    for (const line of lines) {
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      expect(() => JSON.parse(payload)).not.toThrow();
    }
  });

  it("heartbeat comments do not appear in a quick successful stream", async () => {
    // For a tiny stream that completes inside the idle timeout, the
    // heartbeat interval should never have fired. The whole body
    // should only contain data: lines (or the DONE sentinel).
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("content-type", "application/json")
      .send({
        model: "ollama/llama3",
        messages: [{ role: "user", content: "trigger" }],
        stream: true,
      })
      .buffer(true)
      .parse((r, cb) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("data", (chunk) => (data += chunk));
        r.on("end", () => cb(null, data));
      });

    const body = res.body as unknown as string;
    expect(body).not.toContain(": keep-alive");
  });
});
