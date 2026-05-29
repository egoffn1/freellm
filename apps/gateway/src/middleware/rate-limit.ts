import rateLimit from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import { freellmError } from "../errors/index.js";

const windowMs = parseInt(process.env["RATE_LIMIT_WINDOW_MS"] ?? "60000", 10);
const max = parseInt(process.env["RATE_LIMIT_RPM"] ?? "60", 10);

/**
 * Per-client rate limiter (by IP).
 * Configurable via RATE_LIMIT_RPM (default 60) and RATE_LIMIT_WINDOW_MS (default 60000).
 * This is independent of the per-provider rate limiter in the gateway.
 *
 * Delegates the error response to the central handler via next(err) so the
 * body shape matches every other 429 the gateway can produce.
 */
export const clientRateLimit = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Don't rate-limit health checks
    return req.path === "/healthz" || req.path === "/api/healthz";
  },
  handler: (_req: Request, _res: Response, next: NextFunction) => {
    next(
      freellmError({
        code: "client_rate_limited",
        message: `Client rate limit exceeded. Max ${max} requests per ${windowMs / 1000}s.`,
        retry_after_ms: windowMs,
      }),
    );
  },
});
