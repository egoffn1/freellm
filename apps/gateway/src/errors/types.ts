/**
 * FreeLLM error taxonomy.
 *
 * Every error the gateway emits lands in one of the `ErrorType` buckets
 * below (HTTP status-aligned) with a specific `ErrorCode` that clients can
 * key off of for programmatic handling. This file is the single source of
 * truth — nothing else in the codebase may invent its own error shape.
 *
 * The envelope matches OpenAI's `{ error: { type, code, message } }` shape
 * so clients using the OpenAI SDK get reasonable behavior for free, plus
 * FreeLLM-specific fields (`request_id`, `provider`, `retry_after_ms`,
 * `providers`, `suggestions`, `requested_model`) as discriminated extras.
 */

import type { ModelSuggestion, ProviderRetryHint } from "../routing/retry-advice.js";

export type ErrorType =
  | "invalid_request_error" // 400
  | "authentication_error" //  401
  | "permission_error" //      403
  | "not_found_error" //       404
  | "rate_limit_error" //      429
  | "provider_error" //        502
  | "internal_error"; //       500

export type ErrorCode =
  // 400 invalid_request_error
  | "invalid_request"
  | "strict_mode_meta_model_forbidden"
  | "model_not_supported"
  | "no_providers_configured"
  // 401 authentication_error
  | "missing_api_key"
  | "invalid_api_key"
  // 403 permission_error
  | "admin_required"
  // 404 not_found_error
  | "provider_not_found"
  // 429 rate_limit_error
  | "client_rate_limited" //       per-IP middleware
  | "identifier_rate_limited" //   Phase 2
  | "virtual_key_cap_reached" //   Phase 2
  | "provider_rate_limited" //     upstream 429 surfaced in strict mode
  | "all_providers_exhausted" //   no failover path remaining
  // 502 provider_error
  | "provider_upstream_error"
  // 500 internal_error
  | "internal_server_error";

/** Fields a client can expect on every error response, regardless of code. */
export interface FreeLLMErrorBodyBase {
  type: ErrorType;
  code: ErrorCode;
  message: string;
  request_id: string;
}

/** Optional discriminated context fields attached depending on the code. */
export interface FreeLLMErrorBodyContext {
  /** The provider the error originated from (provider_*, retry hints). */
  provider?: string;
  /** The model the client asked for (strict_mode_*, model_not_supported). */
  requested_model?: string;
  /** Milliseconds the client should wait before retrying, when known. */
  retry_after_ms?: number | null;
  /** Per-provider state for all_providers_exhausted / provider_rate_limited. */
  providers?: ProviderRetryHint[];
  /** Meta-model suggestions for all_providers_exhausted. */
  suggestions?: ModelSuggestion[];
  /** Zod issue list for invalid_request, sanitized. */
  issues?: Array<{ path: string; message: string }>;
}

export interface FreeLLMErrorBody {
  error: FreeLLMErrorBodyBase & FreeLLMErrorBodyContext;
}
