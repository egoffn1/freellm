import { type IRouter, type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { freellmError } from "../../errors/index.js";
import {
  BrowserTokenError,
  MAX_TTL_SECONDS,
  isBrowserTokenEnabled,
  signBrowserToken,
} from "../../features/browser-tokens.js";
import { validate } from "../../middleware/validate.js";

const tokensRouter: IRouter = Router();

/**
 * Body for POST /v1/tokens/issue. The identifier pattern matches the
 * sanitization used by the per-identifier rate limit middleware so a
 * token can never mint an identifier that the runtime limiter would
 * later reject.
 */
const issueTokenSchema = z
  .object({
    origin: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (v) => /^https:\/\/[^\s]+$/.test(v) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v),
        "origin must be https://... or http://localhost[:port]",
      ),
    identifier: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,128}$/, "identifier must match ^[A-Za-z0-9_.:-]{1,128}$")
      .optional(),
    ttlSeconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional(),
  })
  .strict();

type IssueTokenBody = z.infer<typeof issueTokenSchema>;

/**
 * POST /v1/tokens/issue
 *
 * Mints a short-lived browser token. The caller must already be
 * authenticated via master key, admin key, or a virtual key (the
 * existing auth middleware handles that). Browser tokens themselves
 * CANNOT mint new tokens: the chain stops here. We detect a browser
 * token caller by looking at req.browserToken which the auth
 * middleware populates on successful flt.* verification; if it's set,
 * we reject the issue call.
 */
tokensRouter.post(
  "/issue",
  validate(issueTokenSchema),
  (req: Request, res: Response, next: NextFunction) => {
    if (req.browserToken) {
      next(
        freellmError({
          code: "admin_required",
          message: "Browser tokens cannot issue new browser tokens.",
        }),
      );
      return;
    }

    if (!isBrowserTokenEnabled()) {
      next(
        freellmError({
          code: "no_providers_configured",
          message:
            "Browser tokens are disabled: set FREELLM_TOKEN_SECRET to at least 32 bytes on the gateway to enable.",
        }),
      );
      return;
    }

    const body = req.body as IssueTokenBody;
    const secret = process.env.FREELLM_TOKEN_SECRET;
    if (!secret) {
      next(
        freellmError({
          code: "internal_server_error",
          message: "Browser token secret is not configured.",
        }),
      );
      return;
    }

    // If the issuer authenticated via a virtual key, bind the token to
    // that virtual key id so Phase 2's cap enforcement flows through.
    const vk = req.virtualKey?.id;

    try {
      const { token, expiresAt, payload } = signBrowserToken({
        secret,
        payload: {
          origin: body.origin,
          identifier: body.identifier,
          vk,
          ttlSeconds: body.ttlSeconds ?? MAX_TTL_SECONDS,
        },
      });

      res.status(201).json({
        token,
        expiresAt,
        origin: payload.origin,
        identifier: payload.identifier ?? null,
      });
    } catch (err) {
      if (err instanceof BrowserTokenError) {
        next(
          freellmError({
            code: "invalid_request",
            message: err.message,
          }),
        );
        return;
      }
      next(err);
    }
  },
);

export default tokensRouter;
