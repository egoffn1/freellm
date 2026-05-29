import type { NextFunction, Request, Response } from "express";
import {
  type FreeLLMError,
  freellmError,
  httpStatusFor,
  isFreeLLMError,
  redactSecrets,
  toBody,
} from "../errors/index.js";
import { logger } from "../logger.js";
import { AllProvidersExhaustedError, ProviderClientError, registry } from "../routing/index.js";
import { buildRetryAdvice, retryAfterSeconds } from "../routing/retry-advice.js";
import { StrictModeError } from "../routing/strict.js";

/** Extract a safe error message from an upstream response without leaking internals. */
async function safeUpstreamMessage(
  response: Response | globalThis.Response,
  fallback: string,
): Promise<string> {
  try {
    const body = await (response as globalThis.Response).json();
    const msg = (body as { error?: { message?: unknown } })?.error?.message;
    return typeof msg === "string" ? redactSecrets(msg) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Normalize any thrown value into a FreeLLMError so the serializer has a
 * single input shape. Gateway hot paths throw cheap typed signals
 * (AllProvidersExhaustedError, ProviderClientError, StrictModeError) and
 * we translate them here exactly once.
 */
async function normalizeError(err: unknown): Promise<FreeLLMError> {
  if (isFreeLLMError(err)) return err;

  if (err instanceof StrictModeError) {
    return freellmError({
      code: "strict_mode_meta_model_forbidden",
      message: redactSecrets(err.message),
      requested_model: err.requestedModel,
    });
  }

  if (err instanceof ProviderClientError) {
    const message = await safeUpstreamMessage(err.upstreamResponse, err.message);
    if (err.statusCode === 429) {
      const advice = buildRetryAdvice(registry.getStatusAll(), [err.providerId]);
      return freellmError({
        code: "provider_rate_limited",
        message: redactSecrets(message),
        provider: err.providerId,
        retry_after_ms: advice.retry_after_ms,
        providers: advice.providers,
        suggestions: advice.suggestions,
      });
    }
    // Non-retriable upstream 4xx → provider_upstream_error at 502.
    return freellmError({
      code: "provider_upstream_error",
      message: redactSecrets(message),
      provider: err.providerId,
    });
  }

  if (err instanceof AllProvidersExhaustedError) {
    const advice = buildRetryAdvice(registry.getStatusAll(), err.triedProviders);
    return freellmError({
      code: "all_providers_exhausted",
      message: redactSecrets(err.message),
      retry_after_ms: advice.retry_after_ms,
      providers: advice.providers,
      suggestions: advice.suggestions,
    });
  }

  // Unknown error — log the original, return a generic internal_error so
  // the caller never sees an uncaught stack trace or internal detail.
  logger.error({ err }, "Unhandled error");
  return freellmError({
    code: "internal_server_error",
    message: "Internal server error",
  });
}

/**
 * Central error handler. Every response body that the app emits on error
 * goes through this function. Must be mounted last, after every route.
 *
 * Defensive: catches any failure inside itself and falls back to a hard-
 * coded internal_error envelope so the caller never sees an HTML 500 from
 * Express's default handler.
 */
export async function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  if (res.headersSent) return;

  try {
    const normalized = await normalizeError(err);
    const status = httpStatusFor(normalized.code);

    // Attach Retry-After for rate-limit-category responses when we know it.
    if (status === 429 && normalized.context.retry_after_ms != null) {
      const secs = retryAfterSeconds({
        retry_after_ms: normalized.context.retry_after_ms,
        providers: normalized.context.providers ?? [],
        suggestions: normalized.context.suggestions ?? [],
      });
      if (secs != null) res.setHeader("Retry-After", String(secs));
    }

    if (normalized.context.provider) {
      res.setHeader("X-FreeLLM-Provider", normalized.context.provider);
    }

    res.status(status).json(toBody(normalized, String(req.id ?? "unknown")));
  } catch (handlerErr) {
    // The handler itself threw. Avoid infinite recursion by emitting the
    // simplest possible envelope — no upstream fetches, no registry reads.
    logger.error({ err: handlerErr }, "Error handler itself failed");
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          type: "internal_error",
          code: "internal_server_error",
          message: "Internal server error",
          request_id: String(req.id ?? "unknown"),
        },
      });
    }
  }
}
