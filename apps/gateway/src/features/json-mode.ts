/**
 * Centralised JSON-mode helpers.
 *
 * Two responsibilities:
 *  1. translateRequestForProvider – rewrite provider-specific request fields
 *     before the request is forwarded upstream (currently only NIM needs this).
 *  2. annotateResponse – inspect a completed non-streaming response and return
 *     an array of warning strings that the caller should surface via headers.
 */
import type { ChatCompletionRequest, ChatCompletionResponse } from "../types.js";

/**
 * Translate JSON-mode fields in `request` for the given provider.
 *
 * Currently the only translation is NIM-specific:
 *   response_format: { type: "json_schema", json_schema: { schema: ... } }
 *   -> nvext: { guided_json: <schema> }   (response_format removed)
 *
 * For every other provider the request is returned unchanged.
 */
export function translateRequestForProvider(
  request: ChatCompletionRequest,
  providerId: string,
): ChatCompletionRequest {
  if (
    providerId === "nim" &&
    request.response_format?.type === "json_schema" &&
    request.response_format.json_schema?.schema
  ) {
    const schema = request.response_format.json_schema.schema;
    const translated = { ...request } as unknown as Record<string, unknown>;
    translated.nvext = { guided_json: schema };
    (translated as Partial<ChatCompletionRequest>).response_format = undefined;
    return translated as unknown as ChatCompletionRequest;
  }

  return request;
}

/**
 * Inspect a non-streaming response and return an array of warning strings.
 *
 * Possible warnings:
 *  - "json-possibly-truncated"  – JSON-mode response finished because
 *    max_tokens was hit, so the output is likely incomplete JSON.
 *  - "schema-validation-failed" – The response content could not be parsed
 *    as JSON, or the parsed object failed lightweight structural validation
 *    against the requested schema.
 *
 * The lightweight schema validation (no external deps) checks:
 *  - Whether the content parses as JSON at all.
 *  - If schema.type === "object", whether the parsed value is a plain object.
 *  - If schema.required is an array, whether every required key is present
 *    as a top-level key in the parsed object.
 */
export function annotateResponse(
  response: ChatCompletionResponse,
  request: ChatCompletionRequest,
): string[] {
  const warnings: string[] = [];
  const fmt = request.response_format?.type;

  if (!fmt || fmt === "text") return warnings;

  // Truncation warning
  if (
    (fmt === "json_object" || fmt === "json_schema") &&
    response.choices?.[0]?.finish_reason === "length"
  ) {
    warnings.push("json-possibly-truncated");
  }

  // Schema validation (json_schema only)
  if (fmt === "json_schema" && request.response_format?.json_schema?.schema) {
    const schema = request.response_format.json_schema.schema as Record<string, unknown>;
    const raw = response.choices?.[0]?.message?.content;
    const content = typeof raw === "string" ? raw : null;

    if (content === null) {
      warnings.push("schema-validation-failed");
      return warnings;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      warnings.push("schema-validation-failed");
      return warnings;
    }

    // Type check
    if (schema.type === "object") {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push("schema-validation-failed");
        return warnings;
      }
    }

    // Required fields check
    const required = schema.required;
    if (
      Array.isArray(required) &&
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const obj = parsed as Record<string, unknown>;
      for (const key of required) {
        if (typeof key === "string" && !(key in obj)) {
          warnings.push("schema-validation-failed");
          return warnings;
        }
      }
    }
  }

  return warnings;
}
