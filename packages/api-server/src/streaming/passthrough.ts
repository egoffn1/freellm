import type { ChatCompletionChunk, Normalizer } from "./types.js";

/**
 * No-op normalizer used for providers that are already OpenAI-spec
 * compliant (Groq, Cerebras, NVIDIA NIM, Mistral when streaming plain
 * text). Emits every chunk untouched.
 */
export function createPassthroughNormalizer(): Normalizer {
  return {
    transform(chunk: ChatCompletionChunk): ChatCompletionChunk[] {
      return [chunk];
    },
    flush(): ChatCompletionChunk[] {
      return [];
    },
  };
}
