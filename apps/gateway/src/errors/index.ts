/**
 * FreeLLM error SDK — public surface.
 *
 * Usage from anywhere in the app:
 *
 *     import { freellmError } from "../errors/index.js";
 *     throw freellmError({
 *       code: "strict_mode_meta_model_forbidden",
 *       message: `Strict mode forbids meta-model "${model}".`,
 *       requested_model: model,
 *     });
 *
 * At the Express edge the central error-handler converts this into the
 * canonical body shape via `toBody(err, req.id)`. Middlewares must never
 * write error JSON bodies themselves — always delegate via `next(err)`.
 */

import type {
  ErrorCode,
  ErrorType,
  FreeLLMErrorBody,
  FreeLLMErrorBodyContext,
} from "./types.js";

export type { ErrorCode, ErrorType, FreeLLMErrorBody, FreeLLMErrorBodyContext } from "./types.js";

/**
 * Single source of truth for HTTP status per error code. Keep this table
 * exhaustive — the tests assert every `ErrorCode` appears here.
 */
const CODE_TO_STATUS: Record<ErrorCode, number> = {
  // 400
  invalid_request: 400,
  strict_mode_meta_model_forbidden: 400,
  model_not_supported: 400,
  no_providers_configured: 400,
  // 401
  missing_api_key: 401,
  invalid_api_key: 401,
  // 403
  admin_required: 403,
  // 404
  provider_not_found: 404,
  // 429
  client_rate_limited: 429,
  identifier_rate_limited: 429,
  virtual_key_cap_reached: 429,
  provider_rate_limited: 429,
  all_providers_exhausted: 429,
  // 502
  provider_upstream_error: 502,
  // 500
  internal_server_error: 500,
};

/**
 * Single source of truth for `type` per code. Derived from the status so a
 * future reader can trace any response back to this table.
 */
const CODE_TO_TYPE: Record<ErrorCode, ErrorType> = {
  // 400 → invalid_request_error
  invalid_request: "invalid_request_error",
  strict_mode_meta_model_forbidden: "invalid_request_error",
  model_not_supported: "invalid_request_error",
  no_providers_configured: "invalid_request_error",
  // 401 → authentication_error
  missing_api_key: "authentication_error",
  invalid_api_key: "authentication_error",
  // 403 → permission_error
  admin_required: "permission_error",
  // 404 → not_found_error
  provider_not_found: "not_found_error",
  // 429 → rate_limit_error
  client_rate_limited: "rate_limit_error",
  identifier_rate_limited: "rate_limit_error",
  virtual_key_cap_reached: "rate_limit_error",
  provider_rate_limited: "rate_limit_error",
  all_providers_exhausted: "rate_limit_error",
  // 502 → provider_error
  provider_upstream_error: "provider_error",
  // 500 → internal_error
  internal_server_error: "internal_error",
};

export function httpStatusFor(code: ErrorCode): number {
  return CODE_TO_STATUS[code];
}

export function typeFor(code: ErrorCode): ErrorType {
  return CODE_TO_TYPE[code];
}

/** Internal FreeLLM signal thrown from the gateway hot paths. */
export class FreeLLMError extends Error {
  public readonly code: ErrorCode;
  public readonly context: FreeLLMErrorBodyContext;

  constructor(code: ErrorCode, message: string, context: FreeLLMErrorBodyContext = {}) {
    super(message);
    this.name = "FreeLLMError";
    this.code = code;
    this.context = context;
  }
}

export interface FreeLLMErrorInit extends FreeLLMErrorBodyContext {
  code: ErrorCode;
  message: string;
}

/** Convenience factory. Throw as `throw freellmError({...})`. */
export function freellmError(init: FreeLLMErrorInit): FreeLLMError {
  const { code, message, ...context } = init;
  return new FreeLLMError(code, message, context);
}

export function isFreeLLMError(err: unknown): err is FreeLLMError {
  return err instanceof FreeLLMError;
}

/**
 * Serialize a FreeLLMError into the canonical wire format. Always includes
 * the supplied `requestId` — callers are responsible for generating it
 * (typically via the `request-id` middleware). Never throws; if `err` is
 * not a FreeLLMError, returns an internal_server_error envelope.
 */
export function toBody(err: unknown, requestId: string): FreeLLMErrorBody {
  if (!isFreeLLMError(err)) {
    return {
      error: {
        type: "internal_error",
        code: "internal_server_error",
        message: "Internal server error",
        request_id: requestId || "unknown",
      },
    };
  }
  return {
    error: {
      type: typeFor(err.code),
      code: err.code,
      message: err.message,
      request_id: requestId || "unknown",
      ...err.context,
    },
  };
}

/**
 * Redact obvious secrets from a message string before it goes on the wire.
 * Catches: Bearer tokens, API-key-looking things (sk-, gsk_, AIza, etc.),
 * high-entropy hex/base64 sequences over 24 chars. Not a replacement for
 * pino `redact` on logs; this is belt-and-suspenders for error messages
 * that might echo user input back.
 */
export function redactSecrets(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-|gsk_|AIza|csk-|glsa_)[A-Za-z0-9._~+/=-]{16,}\b/g, "[REDACTED_KEY]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED_HEX]");
}
