import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

/**
 * Assigns every incoming request a UUID (honoring an inbound `X-Request-Id`
 * if the caller supplies one up to 128 chars), exposes it via `req.id`, and
 * echoes it back on `X-Request-Id`. Must mount BEFORE body-parser and every
 * other middleware so errors thrown by `express.json()` still carry an ID.
 *
 * Pino's `pinoHttp` is wired to the same value via `genReqId` so a single
 * grep on `request_id` covers access logs, error logs, and response bodies.
 */

const INBOUND_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

// Note: `req.id` is already typed as `ReqId = string | number` by pino-http's
// ambient declaration. We don't augment it further — instead we always
// coerce to string at consumption time via `String(req.id ?? "unknown")`.

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers["x-request-id"];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  req.id =
    typeof candidate === "string" && INBOUND_ID_PATTERN.test(candidate)
      ? candidate
      : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}
