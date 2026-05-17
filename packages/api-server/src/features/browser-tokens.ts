/**
 * Stateless browser tokens.
 *
 * Lets an operator mint short-lived bearer tokens that are safe to put
 * in browser JavaScript. The token is an HMAC-SHA256-signed JSON payload
 * carrying an origin, an expiry, and optionally an identifier and a
 * virtual key id. Verification is pure (no DB lookups), so every
 * instance of the gateway can verify every token as long as they share
 * the same secret via env.
 *
 * Format on the wire:
 *
 *     flt.<base64url(payload_json)>.<hex(hmac_sha256(payload_json))>
 *
 * Payload v1 shape:
 *
 *     {
 *       "v": 1,
 *       "iat": 1775698500,
 *       "exp": 1775699400,
 *       "origin": "https://yoursite.com",
 *       "identifier": "session-abc",
 *       "vk": "sk-freellm-portfolio-abc123"
 *     }
 *
 * Security model:
 *   - Max ttl 900 seconds (15 minutes). Clamped at issue time.
 *   - Origin is baked into the token and compared against the browser's
 *     Origin header on every verify. Mismatch = reject.
 *   - Secret must be at least 32 bytes. Enforced at boot in server.ts;
 *     this module double-checks every operation so tests and future
 *     callers cannot sneak a short secret through.
 *   - Constant-time signature comparison via timingSafeEqual.
 *   - If the operator rotates FREELLM_TOKEN_SECRET, every outstanding
 *     token immediately fails verification. This is intentional and
 *     documented as the kill switch for compromised deployments.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const MIN_SECRET_BYTES = 32;
export const MAX_TTL_SECONDS = 900;
export const CURRENT_VERSION = 1;
export const TOKEN_PREFIX = "flt.";

/** Fields carried in every browser-token payload. */
export interface BrowserTokenPayload {
  /** Payload format version. Only 1 today. */
  v: 1;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expires-at (unix seconds). */
  exp: number;
  /** The allowed browser Origin for this token. */
  origin: string;
  /** Optional per-user identifier that the gateway uses as the identifier bucket key. */
  identifier?: string;
  /** Virtual key id whose caps apply to requests authed by this token. */
  vk?: string;
}

export type BrowserTokenReason =
  | "missing_secret"
  | "short_secret"
  | "invalid_format"
  | "invalid_base64"
  | "invalid_json"
  | "invalid_version"
  | "invalid_payload"
  | "bad_signature"
  | "expired"
  | "origin_mismatch"
  | "ttl_too_large"
  | "ttl_too_small";

export class BrowserTokenError extends Error {
  constructor(
    public readonly reason: BrowserTokenReason,
    message: string,
  ) {
    super(message);
    this.name = "BrowserTokenError";
  }
}

export interface SignOptions {
  payload: Omit<BrowserTokenPayload, "v" | "iat" | "exp"> & {
    ttlSeconds: number;
  };
  secret: string;
  now?: number;
}

export interface SignResult {
  token: string;
  expiresAt: string;
  payload: BrowserTokenPayload;
}

/**
 * Sign a new browser token. Throws BrowserTokenError for any invalid
 * input (short secret, out-of-range ttl, missing origin).
 */
export function signBrowserToken(opts: SignOptions): SignResult {
  assertSecret(opts.secret);

  const ttl = Math.floor(opts.payload.ttlSeconds);
  if (!Number.isFinite(ttl) || ttl < 1) {
    throw new BrowserTokenError(
      "ttl_too_small",
      `ttlSeconds must be >= 1, got ${opts.payload.ttlSeconds}`,
    );
  }
  if (ttl > MAX_TTL_SECONDS) {
    throw new BrowserTokenError(
      "ttl_too_large",
      `ttlSeconds must be <= ${MAX_TTL_SECONDS}, got ${ttl}`,
    );
  }
  if (!opts.payload.origin || typeof opts.payload.origin !== "string") {
    throw new BrowserTokenError("invalid_payload", "origin is required");
  }

  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const payload: BrowserTokenPayload = {
    v: CURRENT_VERSION,
    iat: nowSeconds,
    exp: nowSeconds + ttl,
    origin: opts.payload.origin,
    ...(opts.payload.identifier ? { identifier: opts.payload.identifier } : {}),
    ...(opts.payload.vk ? { vk: opts.payload.vk } : {}),
  };

  const payloadJson = JSON.stringify(payload);
  const payloadB64 = toBase64Url(Buffer.from(payloadJson, "utf8"));
  const sigHex = signHex(payloadJson, opts.secret);
  const token = `${TOKEN_PREFIX}${payloadB64}.${sigHex}`;

  return {
    token,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    payload,
  };
}

export interface VerifyOptions {
  token: string;
  secret: string;
  expectedOrigin: string | null;
  now?: number;
}

/**
 * Verify a browser token. On success returns the payload. Throws
 * BrowserTokenError with a discrete reason otherwise, so the auth
 * middleware can map to the right FreeLLMError code.
 */
export function verifyBrowserToken(opts: VerifyOptions): BrowserTokenPayload {
  assertSecret(opts.secret);

  if (typeof opts.token !== "string" || !opts.token.startsWith(TOKEN_PREFIX)) {
    throw new BrowserTokenError("invalid_format", "token does not start with flt.");
  }

  const rest = opts.token.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 0) {
    throw new BrowserTokenError("invalid_format", "token missing signature section");
  }

  const payloadB64 = rest.slice(0, dot);
  const sigHex = rest.slice(dot + 1);
  if (payloadB64.length === 0 || sigHex.length === 0) {
    throw new BrowserTokenError("invalid_format", "empty payload or signature");
  }

  let payloadJson: string;
  try {
    payloadJson = Buffer.from(fromBase64Url(payloadB64), "base64").toString("utf8");
  } catch {
    throw new BrowserTokenError("invalid_base64", "payload is not valid base64url");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new BrowserTokenError("invalid_json", "payload is not valid JSON");
  }

  if (!isPayload(parsed)) {
    throw new BrowserTokenError("invalid_payload", "payload missing required fields");
  }
  if (parsed.v !== CURRENT_VERSION) {
    throw new BrowserTokenError(
      "invalid_version",
      `unsupported payload version ${parsed.v}`,
    );
  }

  // Verify the signature BEFORE trusting any payload fields. This keeps
  // constant-time comparison invariants clean and makes sure we never
  // leak information about payload contents on a bad signature.
  const expectedSig = signHex(payloadJson, opts.secret);
  if (!constantTimeEqualHex(sigHex, expectedSig)) {
    throw new BrowserTokenError("bad_signature", "signature does not match");
  }

  // Now it's safe to apply the payload's expectations.
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  if (nowSeconds >= parsed.exp) {
    throw new BrowserTokenError(
      "expired",
      `token expired at ${new Date(parsed.exp * 1000).toISOString()}`,
    );
  }

  if (opts.expectedOrigin !== parsed.origin) {
    throw new BrowserTokenError(
      "origin_mismatch",
      `token origin ${parsed.origin} does not match request Origin ${opts.expectedOrigin ?? "(missing)"}`,
    );
  }

  return parsed;
}

/** True if the process is configured to accept browser tokens at all. */
export function isBrowserTokenEnabled(): boolean {
  const secret = process.env["FREELLM_TOKEN_SECRET"];
  return !!secret && Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES;
}

/**
 * Throws if the secret is missing or shorter than MIN_SECRET_BYTES.
 * Used both at boot (server.ts) and on every sign/verify call so there
 * is no path where a short secret produces a valid token.
 */
export function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret) {
    throw new BrowserTokenError(
      "missing_secret",
      "FREELLM_TOKEN_SECRET is not set; browser tokens are disabled",
    );
  }
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new BrowserTokenError(
      "short_secret",
      `FREELLM_TOKEN_SECRET must be at least ${MIN_SECRET_BYTES} bytes, got ${Buffer.byteLength(secret, "utf8")}`,
    );
  }
}

/** HMAC-SHA256 hex digest of the payload JSON. */
function signHex(payloadJson: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadJson).digest("hex");
}

function isPayload(value: unknown): value is BrowserTokenPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v["v"] !== "number") return false;
  if (typeof v["iat"] !== "number") return false;
  if (typeof v["exp"] !== "number") return false;
  if (typeof v["origin"] !== "string" || v["origin"].length === 0) return false;
  if (v["identifier"] !== undefined && typeof v["identifier"] !== "string") return false;
  if (v["vk"] !== undefined && typeof v["vk"] !== "string") return false;
  return true;
}

/** Base64url encoding: base64 with +//= replaced for URL safety. */
function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Reverse of toBase64Url — accepts URL-safe base64 and rehydrates padding. */
function fromBase64Url(s: string): string {
  const padLen = (4 - (s.length % 4)) % 4;
  return s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
}

/**
 * Constant-time comparison of two hex strings. Returns false for any
 * length mismatch without leaking the lengths via a short-circuit.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
