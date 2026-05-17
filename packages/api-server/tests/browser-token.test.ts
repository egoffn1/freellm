import { describe, it, expect } from "vitest";
import {
  signBrowserToken,
  verifyBrowserToken,
  isBrowserTokenEnabled,
  BrowserTokenError,
  assertSecret,
  MIN_SECRET_BYTES,
  MAX_TTL_SECONDS,
  TOKEN_PREFIX,
} from "../src/features/browser-tokens.js";

// 48-byte secret (well above MIN_SECRET_BYTES).
const SECRET = "unit-test-secret-48-bytes-0123456789abcdef0123456";
const OTHER_SECRET = "different-secret-48-bytes-abcdefghijklmnopqrstuvwx";

describe("assertSecret", () => {
  it("accepts a sufficiently long secret", () => {
    expect(() => assertSecret(SECRET)).not.toThrow();
  });

  it("rejects an undefined secret", () => {
    expect(() => assertSecret(undefined)).toThrow(BrowserTokenError);
    try {
      assertSecret(undefined);
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("missing_secret");
    }
  });

  it("rejects a short secret", () => {
    expect(() => assertSecret("short")).toThrow(BrowserTokenError);
    try {
      assertSecret("short");
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("short_secret");
    }
  });

  it("MIN_SECRET_BYTES matches the documented threshold", () => {
    expect(MIN_SECRET_BYTES).toBe(32);
  });
});

describe("signBrowserToken", () => {
  it("produces a token that starts with the flt. prefix", () => {
    const result = signBrowserToken({
      secret: SECRET,
      payload: { origin: "https://example.com", ttlSeconds: 60 },
    });
    expect(result.token.startsWith(TOKEN_PREFIX)).toBe(true);
  });

  it("carries iat, exp, origin, and optional fields on the payload", () => {
    const now = 1_800_000_000_000;
    const result = signBrowserToken({
      secret: SECRET,
      now,
      payload: {
        origin: "https://example.com",
        identifier: "user-42",
        vk: "sk-freellm-demo-0001",
        ttlSeconds: 120,
      },
    });
    expect(result.payload.v).toBe(1);
    expect(result.payload.iat).toBe(1_800_000_000);
    expect(result.payload.exp).toBe(1_800_000_120);
    expect(result.payload.origin).toBe("https://example.com");
    expect(result.payload.identifier).toBe("user-42");
    expect(result.payload.vk).toBe("sk-freellm-demo-0001");
    expect(result.expiresAt).toBe(new Date(1_800_000_120_000).toISOString());
  });

  it("rejects ttl below 1", () => {
    expect(() =>
      signBrowserToken({
        secret: SECRET,
        payload: { origin: "https://example.com", ttlSeconds: 0 },
      }),
    ).toThrow(BrowserTokenError);
  });

  it("rejects ttl above MAX_TTL_SECONDS", () => {
    try {
      signBrowserToken({
        secret: SECRET,
        payload: { origin: "https://example.com", ttlSeconds: MAX_TTL_SECONDS + 1 },
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("ttl_too_large");
    }
  });

  it("rejects empty origin", () => {
    try {
      signBrowserToken({
        secret: SECRET,
        payload: { origin: "", ttlSeconds: 60 },
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("invalid_payload");
    }
  });

  it("refuses to sign with a short secret", () => {
    expect(() =>
      signBrowserToken({
        secret: "short",
        payload: { origin: "https://example.com", ttlSeconds: 60 },
      }),
    ).toThrow(BrowserTokenError);
  });
});

describe("verifyBrowserToken", () => {
  it("verifies a freshly-signed token with a matching origin", () => {
    const now = 1_800_000_000_000;
    const { token, payload } = signBrowserToken({
      secret: SECRET,
      now,
      payload: { origin: "https://example.com", ttlSeconds: 60 },
    });
    const verified = verifyBrowserToken({
      token,
      secret: SECRET,
      expectedOrigin: "https://example.com",
      now: now + 1000,
    });
    expect(verified).toEqual(payload);
  });

  it("rejects a token that does not start with flt.", () => {
    try {
      verifyBrowserToken({
        token: "oops.xyz.abc",
        secret: SECRET,
        expectedOrigin: "https://example.com",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("invalid_format");
    }
  });

  it("rejects a token with a tampered payload (bad signature)", () => {
    const { token } = signBrowserToken({
      secret: SECRET,
      payload: { origin: "https://example.com", ttlSeconds: 60 },
    });
    // Tamper with one character in the payload section.
    const dot = token.indexOf(".", 4);
    const mutated = token.slice(0, 5) + "X" + token.slice(6, dot) + token.slice(dot);
    try {
      verifyBrowserToken({
        token: mutated,
        secret: SECRET,
        expectedOrigin: "https://example.com",
      });
      expect.fail("should have thrown");
    } catch (err) {
      // Tampering with the payload either breaks JSON/base64 or fails
      // signature verification; both count as rejection.
      expect(err).toBeInstanceOf(BrowserTokenError);
      const reason = (err as BrowserTokenError).reason;
      expect(["bad_signature", "invalid_json", "invalid_base64", "invalid_payload"]).toContain(reason);
    }
  });

  it("rejects a token with a tampered signature", () => {
    const { token } = signBrowserToken({
      secret: SECRET,
      payload: { origin: "https://example.com", ttlSeconds: 60 },
    });
    // Flip the last character of the signature section.
    const lastChar = token.slice(-1);
    const flipped = lastChar === "0" ? "1" : "0";
    const mutated = token.slice(0, -1) + flipped;
    try {
      verifyBrowserToken({
        token: mutated,
        secret: SECRET,
        expectedOrigin: "https://example.com",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("bad_signature");
    }
  });

  it("rejects an expired token", () => {
    const now = 1_800_000_000_000;
    const { token } = signBrowserToken({
      secret: SECRET,
      now,
      payload: { origin: "https://example.com", ttlSeconds: 10 },
    });
    try {
      verifyBrowserToken({
        token,
        secret: SECRET,
        expectedOrigin: "https://example.com",
        now: now + 60_000, // well past expiry
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("expired");
    }
  });

  it("rejects an origin mismatch", () => {
    const { token } = signBrowserToken({
      secret: SECRET,
      payload: { origin: "https://example.com", ttlSeconds: 60 },
    });
    try {
      verifyBrowserToken({
        token,
        secret: SECRET,
        expectedOrigin: "https://evil.com",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("origin_mismatch");
    }
  });

  it("rejects a missing Origin header (null expectedOrigin)", () => {
    const { token } = signBrowserToken({
      secret: SECRET,
      payload: { origin: "https://example.com", ttlSeconds: 60 },
    });
    try {
      verifyBrowserToken({
        token,
        secret: SECRET,
        expectedOrigin: null,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("origin_mismatch");
    }
  });

  it("rejects verification with a different secret", () => {
    const { token } = signBrowserToken({
      secret: SECRET,
      payload: { origin: "https://example.com", ttlSeconds: 60 },
    });
    try {
      verifyBrowserToken({
        token,
        secret: OTHER_SECRET,
        expectedOrigin: "https://example.com",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("bad_signature");
    }
  });

  it("refuses to verify with a short secret", () => {
    try {
      verifyBrowserToken({
        token: "flt.abc.def",
        secret: "short",
        expectedOrigin: "https://example.com",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as BrowserTokenError).reason).toBe("short_secret");
    }
  });
});

describe("isBrowserTokenEnabled", () => {
  it("returns false when the secret is unset", () => {
    const prev = process.env["FREELLM_TOKEN_SECRET"];
    delete process.env["FREELLM_TOKEN_SECRET"];
    try {
      expect(isBrowserTokenEnabled()).toBe(false);
    } finally {
      if (prev !== undefined) process.env["FREELLM_TOKEN_SECRET"] = prev;
    }
  });

  it("returns false when the secret is too short", () => {
    const prev = process.env["FREELLM_TOKEN_SECRET"];
    process.env["FREELLM_TOKEN_SECRET"] = "short";
    try {
      expect(isBrowserTokenEnabled()).toBe(false);
    } finally {
      if (prev !== undefined) {
        process.env["FREELLM_TOKEN_SECRET"] = prev;
      } else {
        delete process.env["FREELLM_TOKEN_SECRET"];
      }
    }
  });

  it("returns true when the secret meets the minimum", () => {
    const prev = process.env["FREELLM_TOKEN_SECRET"];
    process.env["FREELLM_TOKEN_SECRET"] = SECRET;
    try {
      expect(isBrowserTokenEnabled()).toBe(true);
    } finally {
      if (prev !== undefined) {
        process.env["FREELLM_TOKEN_SECRET"] = prev;
      } else {
        delete process.env["FREELLM_TOKEN_SECRET"];
      }
    }
  });
});
