import type { Request, Response, NextFunction } from "express";
import type { ZodType } from "zod";
import { freellmError, redactSecrets } from "../errors/index.js";

/**
 * Zod body validation. On failure, forwards a typed invalid_request error
 * to the central handler — never writes the response body directly. Zod
 * issues are sanitized through `redactSecrets` in case user input contained
 * a Bearer token or API-key-looking value that would otherwise echo back.
 */
export function validate<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: redactSecrets(i.message),
      }));
      const summary = issues.map((i) => `${i.path || "body"}: ${i.message}`).join("; ");
      next(
        freellmError({
          code: "invalid_request",
          message: summary,
          issues,
        }),
      );
      return;
    }
    req.body = result.data;
    next();
  };
}
