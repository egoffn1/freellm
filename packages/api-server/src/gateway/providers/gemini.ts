import { BaseProvider, parseApiKeys } from "./base.js";
import type { ChatCompletionRequest, ModelObject } from "../types.js";

/**
 * Gemini OpenAI-compatibility adapter.
 *
 * Three non-obvious translations live here because Google's OpenAI-compat
 * endpoint does not quite match the OpenAI Chat Completions contract:
 *
 * 1. **Reasoning models eat the output budget.** Gemini 2.5 Flash and
 *    Gemini 2.5 Pro are reasoning models. By default they spend the
 *    majority of `max_tokens` on internal thinking before producing
 *    visible output, which leaves callers with 30-150 tokens no matter
 *    how large they set the cap. We inject a per-model
 *    `reasoning_effort` default that keeps thinking from starving the
 *    visible response. Callers that explicitly send a value keep it.
 *
 *    Per-model defaults (empirically derived against the live API):
 *      - gemini-2.5-flash -> "none"  (2.5 Flash accepts zero thinking
 *                                      budget and returns the full
 *                                      requested output)
 *      - gemini-2.5-pro   -> "low"   (2.5 Pro rejects "none" with a
 *                                      400 "Budget 0 is invalid. This
 *                                      model only works in thinking
 *                                      mode." "low" is the minimum
 *                                      Google accepts for this model.)
 *
 * 2. **Exactly one of `max_tokens` / `max_completion_tokens`.** Gemini's
 *    OpenAI-compat endpoint returns a 400 "max_tokens and
 *    max_completion_tokens cannot both be set" when both are present.
 *    The documented field for reasoning models is
 *    `max_completion_tokens`, so we normalize: if the caller sent
 *    `max_tokens`, rename it to `max_completion_tokens` and drop the
 *    original. If the caller sent both, prefer the explicit
 *    `max_completion_tokens` and drop the other.
 *
 * 3. **Deprecated 2.0 models removed from the catalog.** Google
 *    returned 404 "This model models/gemini-2.0-flash is no longer
 *    available to new users" for both 2.0-flash and 2.0-flash-lite,
 *    so the catalog only exposes the 2.5 family.
 *
 * Everything else flows through the base mapRequest untouched.
 */
export class GeminiProvider extends BaseProvider {
  readonly id = "gemini";
  readonly name = "Gemini";
  override readonly supportsStreamUsage = true;

  get baseUrl(): string {
    return process.env["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta/openai";
  }

  readonly models: ModelObject[] = [
    { id: "gemini/gemini-2.5-flash", object: "model", created: 1700000000, owned_by: "google", provider: "gemini", supportsVision: true },
    { id: "gemini/gemini-2.5-pro", object: "model", created: 1700000000, owned_by: "google", provider: "gemini", supportsVision: true },
  ];

  protected getApiKeys(): string[] {
    return parseApiKeys(process.env["GEMINI_API_KEY"]);
  }

  protected override mapRequest(
    request: ChatCompletionRequest,
  ): ChatCompletionRequest {
    const mapped = super.mapRequest(request);

    // Per-model reasoning_effort default. The base mapRequest already
    // stripped the "gemini/" prefix so `mapped.model` is the raw model
    // id Gemini expects ("gemini-2.5-flash", "gemini-2.5-pro", etc.).
    if (mapped.reasoning_effort === undefined) {
      mapped.reasoning_effort = defaultReasoningEffortFor(mapped.model);
    }

    // Normalize the output budget to max_completion_tokens only.
    // Gemini OpenAI-compat returns 400 when both max_tokens and
    // max_completion_tokens are present, so we must carry exactly one.
    // Strategy: prefer max_completion_tokens when set; otherwise lift
    // max_tokens into it. Delete max_tokens on the outgoing request
    // in either case so Gemini never sees both.
    if (mapped.max_completion_tokens == null && mapped.max_tokens != null) {
      mapped.max_completion_tokens = mapped.max_tokens;
    }
    if (mapped.max_tokens != null) {
      delete (mapped as { max_tokens?: number | null }).max_tokens;
    }

    return mapped;
  }
}

/**
 * Exported for tests. Returns the default reasoning effort Gemini
 * should receive when the caller did not set one. Falls back to "low"
 * for unknown model ids as a conservative default that is accepted by
 * every current Gemini model.
 */
export function defaultReasoningEffortFor(
  modelId: string,
): "none" | "low" | "medium" | "high" {
  // 2.5 Pro requires a non-zero thinking budget, so the smallest value
  // it will accept is "low". Falling below that returns 400.
  if (modelId.includes("2.5-pro")) return "low";
  // 2.5 Flash accepts "none" and returns the full requested output.
  if (modelId.includes("2.5-flash")) return "none";
  // Any future reasoning model: "low" is the safe conservative choice
  // because every Gemini reasoning model accepts at least "low".
  return "low";
}
