import { describe, expect, it } from "vitest";
import {
  PROVIDER_PRIVACY,
  daysSinceVerified,
  parsePrivacyHeader,
  policiesAllowedBy,
  providerSatisfiesPrivacy,
} from "../src/routing/privacy.js";

describe("parsePrivacyHeader", () => {
  it("returns 'any' when header is missing or empty", () => {
    expect(parsePrivacyHeader(undefined)).toBe("any");
    expect(parsePrivacyHeader(null)).toBe("any");
    expect(parsePrivacyHeader("")).toBe("any");
  });

  it("parses 'no-training' in any case with whitespace tolerance", () => {
    expect(parsePrivacyHeader("no-training")).toBe("no-training");
    expect(parsePrivacyHeader("NO-TRAINING")).toBe("no-training");
    expect(parsePrivacyHeader("  no-training  ")).toBe("no-training");
  });

  it("parses 'any' explicitly", () => {
    expect(parsePrivacyHeader("any")).toBe("any");
  });

  it("falls back to 'any' on unknown values (never throws)", () => {
    expect(parsePrivacyHeader("strict")).toBe("any");
    expect(parsePrivacyHeader("true")).toBe("any");
    expect(parsePrivacyHeader("garbage")).toBe("any");
    expect(parsePrivacyHeader(42)).toBe("any");
  });
});

describe("policiesAllowedBy", () => {
  it("no-training includes local providers", () => {
    const allowed = policiesAllowedBy("no-training");
    expect(allowed.has("no-training")).toBe(true);
    expect(allowed.has("local")).toBe(true);
    expect(allowed.has("free-tier-trains")).toBe(false);
    expect(allowed.has("configurable")).toBe(false);
  });

  it("any accepts every policy", () => {
    const allowed = policiesAllowedBy("any");
    for (const p of ["no-training", "free-tier-trains", "configurable", "local"] as const) {
      expect(allowed.has(p)).toBe(true);
    }
  });
});

describe("providerSatisfiesPrivacy", () => {
  it("any always allows every configured provider", () => {
    for (const id of Object.keys(PROVIDER_PRIVACY)) {
      expect(providerSatisfiesPrivacy(id, "any")).toBe(true);
    }
  });

  it("no-training allows groq (contractually excluded from training)", () => {
    expect(providerSatisfiesPrivacy("groq", "no-training")).toBe(true);
  });

  it("no-training blocks gemini (free tier trains)", () => {
    expect(providerSatisfiesPrivacy("gemini", "no-training")).toBe(false);
  });

  it("no-training blocks configurable providers (operator must opt out)", () => {
    expect(providerSatisfiesPrivacy("mistral", "no-training")).toBe(false);
  });

  it("no-training allows ollama (local)", () => {
    expect(providerSatisfiesPrivacy("ollama", "no-training")).toBe(true);
  });

  it("fails closed on unknown provider ids", () => {
    expect(providerSatisfiesPrivacy("mystery", "no-training")).toBe(false);
    // any is the default; an unknown provider is still "allowed" in any mode
    expect(providerSatisfiesPrivacy("mystery", "any")).toBe(true);
  });
});

describe("daysSinceVerified", () => {
  it("returns 0 for an entry verified today", () => {
    const now = Date.parse("2026-04-09T12:00:00Z");
    expect(
      daysSinceVerified(
        {
          policy: "no-training",
          source_url: "https://example.com",
          last_verified: "2026-04-09",
        },
        now,
      ),
    ).toBe(0);
  });

  it("returns the number of full days elapsed", () => {
    const now = Date.parse("2026-07-09T00:00:00Z");
    expect(
      daysSinceVerified(
        {
          policy: "no-training",
          source_url: "https://example.com",
          last_verified: "2026-04-09",
        },
        now,
      ),
    ).toBe(91);
  });

  it("returns Infinity for an unparseable date", () => {
    expect(
      daysSinceVerified({
        policy: "no-training",
        source_url: "https://example.com",
        last_verified: "not a date",
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("PROVIDER_PRIVACY catalog coverage", () => {
  // The catalog must cover every provider id the gateway actually ships.
  // Update both the catalog and this list when adding a new provider.
  const EXPECTED_IDS = [
    "groq",
    "gemini",
    "mistral",
    "cerebras",
    "nim",
    "cloudflare",
    "github",
    "ollama",
  ];

  it("has an entry for every shipped provider id", () => {
    for (const id of EXPECTED_IDS) {
      expect(PROVIDER_PRIVACY[id]).toBeDefined();
    }
  });

  it("every entry has a source_url that looks like an https link", () => {
    for (const [id, entry] of Object.entries(PROVIDER_PRIVACY)) {
      expect(entry.source_url, `${id} source_url`).toMatch(/^https:\/\//);
    }
  });

  it("every entry has a parseable ISO date in last_verified", () => {
    for (const [id, entry] of Object.entries(PROVIDER_PRIVACY)) {
      expect(
        Number.isFinite(Date.parse(entry.last_verified)),
        `${id} last_verified is parseable`,
      ).toBe(true);
    }
  });
});
