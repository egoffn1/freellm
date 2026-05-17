/**
 * Integration tests for the v1.4 additions to /v1/status and
 * /v1/status/virtual-keys:
 *   - ProviderStatusInfo now carries a privacy block
 *   - A new admin-authed endpoint lists loaded virtual keys with masked ids
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import type { Express } from "express";

let tmpDir: string;
let app: Express;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "freellm-status-v14-"));
  const virtualKeysPath = path.join(tmpDir, "virtual-keys.json");
  writeFileSync(
    virtualKeysPath,
    JSON.stringify({
      keys: [
        {
          id: "sk-freellm-dashboard-demo-0001",
          label: "dashboard demo",
          dailyRequestCap: 100,
          dailyTokenCap: 10000,
          allowedModels: ["free-fast"],
          expiresAt: "2099-01-01T00:00:00Z",
        },
      ],
    }),
  );

  // Matches the realistic production pattern: one master key that gets
  // you through the regular auth middleware, plus a separate admin key
  // that the adminAuth middleware checks for mutation and inventory routes.
  process.env["FREELLM_API_KEY"] = "master-key-for-status-v14-test";
  process.env["FREELLM_ADMIN_KEY"] = "admin-key-for-status-v14-test";
  process.env["FREELLM_TOKEN_SECRET"] =
    "status-v14-browser-token-secret-32bytes!!";
  process.env["FREELLM_VIRTUAL_KEYS_PATH"] = virtualKeysPath;
  process.env["RATE_LIMIT_RPM"] = "100000";
  process.env["FREELLM_IDENTIFIER_LIMIT"] = "1000/60000";
  // Enable Ollama so the provider list isn't empty.
  process.env["OLLAMA_BASE_URL"] = "http://127.0.0.1:9999";
  process.env["OLLAMA_MODELS"] = "llama3";

  const { initVirtualKeys } = await import("../src/features/virtual-keys.js");
  initVirtualKeys();

  const mod = await import("../src/app.js");
  app = mod.default;
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

const MASTER_BEARER = "Bearer master-key-for-status-v14-test";
const ADMIN_BEARER = "Bearer admin-key-for-status-v14-test";

describe("GET /v1/status privacy field", () => {
  it("returns a privacy block on every known provider", async () => {
    const res = await request(app).get("/v1/status").set("authorization", MASTER_BEARER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.providers)).toBe(true);

    for (const p of res.body.providers) {
      expect(p.privacy).toBeDefined();
      expect(p.privacy).toHaveProperty("policy");
      expect(p.privacy).toHaveProperty("sourceUrl");
      expect(p.privacy).toHaveProperty("lastVerified");
      expect(p.privacy.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("marks groq as no-training and gemini as free-tier-trains", async () => {
    const res = await request(app).get("/v1/status").set("authorization", MASTER_BEARER);
    const byId = new Map(
      res.body.providers.map(
        (p: { id: string; privacy: { policy: string } }) => [p.id, p.privacy.policy],
      ),
    );
    expect(byId.get("groq")).toBe("no-training");
    expect(byId.get("gemini")).toBe("free-tier-trains");
    expect(byId.get("ollama")).toBe("local");
  });
});

describe("GET /v1/status browserTokens field", () => {
  it("returns enabled=true when FREELLM_TOKEN_SECRET meets the minimum length", async () => {
    const res = await request(app).get("/v1/status").set("authorization", MASTER_BEARER);
    expect(res.status).toBe(200);
    expect(res.body.browserTokens).toBeDefined();
    expect(res.body.browserTokens.enabled).toBe(true);
    expect(res.body.browserTokens.minSecretBytes).toBe(32);
    expect(res.body.browserTokens.maxTtlSeconds).toBe(900);
  });
});

describe("GET /v1/status/virtual-keys", () => {
  it("rejects requests with no credential at all", async () => {
    const res = await request(app).get("/v1/status/virtual-keys");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("missing_api_key");
  });

  it("rejects a master-key holder who is not the admin", async () => {
    const res = await request(app)
      .get("/v1/status/virtual-keys")
      .set("authorization", MASTER_BEARER);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("admin_required");
  });

  it("returns loaded keys with masked ids for the admin", async () => {
    const res = await request(app)
      .get("/v1/status/virtual-keys")
      .set("authorization", ADMIN_BEARER);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.softCapWarning).toMatch(/reset on process restart/i);
    expect(Array.isArray(res.body.keys)).toBe(true);

    const key = res.body.keys[0];
    expect(key.label).toBe("dashboard demo");
    // The raw id is never returned. Masked form only.
    expect(key.maskedId).toMatch(/^sk-freellm-d/);
    expect(key.maskedId).toContain("...");
    expect(key).not.toHaveProperty("id");

    // Cap fields
    expect(key.dailyRequestCap).toBe(100);
    expect(key.dailyTokenCap).toBe(10000);
    expect(key.requestCapRemaining).toBe(100);
    expect(key.tokenCapRemaining).toBe(10000);
    expect(key.requestsInWindow).toBe(0);
    expect(key.tokensInWindow).toBe(0);

    // Model allowlist pass-through
    expect(key.allowedModels).toEqual(["free-fast"]);

    // Expiry pass-through + computed bool
    expect(key.expiresAt).toBe("2099-01-01T00:00:00Z");
    expect(key.expired).toBe(false);
  });
});
