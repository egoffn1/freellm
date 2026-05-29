/**
 * Per-provider streaming normalizer factory.
 *
 * The streaming chat route creates one normalizer per upstream
 * response, selected by provider id. Unknown providers default to
 * passthrough so a new provider adapter that ships without a
 * normalizer still works (it just doesn't get any bug fixes).
 */
import { createPassthroughNormalizer } from "./passthrough.js";
import { createGeminiNormalizer } from "./gemini.js";
import { createOllamaNormalizer } from "./ollama.js";
import type { Normalizer } from "./types.js";

export function createNormalizer(providerId: string): Normalizer {
  switch (providerId) {
    case "gemini":
      return createGeminiNormalizer();
    case "ollama":
      return createOllamaNormalizer();
    // Groq, Cerebras, NIM, Mistral are known-compliant today. If any of
    // them drifts, add a dedicated normalizer here without changing the
    // callers.
    default:
      return createPassthroughNormalizer();
  }
}
