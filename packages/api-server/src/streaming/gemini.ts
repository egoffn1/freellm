/**
 * Gemini streaming normalizer.
 *
 * Gemini's OpenAI-compatibility mode has a documented, year-old bug:
 * streaming tool_call deltas omit the `index` field that the OpenAI
 * spec requires. See:
 *
 *   https://discuss.ai.google.dev/t/gemini-openai-compatibility-issue-with-tool-call-streaming/59886
 *
 * Every OpenAI client (Node SDK, Python SDK, agent frameworks) uses
 * `index` to reassemble a single logical tool call from its streamed
 * fragments, and to distinguish multiple parallel tool calls from
 * each other. Without `index`, consumers either merge unrelated
 * calls together or drop them entirely.
 *
 * This normalizer fills the missing index. Strategy:
 *
 *   1. When a delta chunk has `tool_calls[]` and any entry is missing
 *      `index`, look up (or mint) an index for its function name.
 *   2. The same function name across multiple fragment chunks keeps
 *      its first-seen index, so argument fragments concatenate in the
 *      right tool call on the client side.
 *   3. If a chunk has `tool_calls[]` with entries that already have
 *      `index` set, we leave them alone (future Gemini fix will make
 *      us a pure passthrough).
 *
 * Non-tool-call deltas (plain content, role, finish_reason) pass
 * through byte-identical.
 */
import type {
  ChatCompletionChunk,
  ChatCompletionChunkChoice,
  Normalizer,
  ToolCallDelta,
} from "./types.js";

export function createGeminiNormalizer(): Normalizer {
  /**
   * Map function name → assigned index. We key on name because Gemini
   * streams the same function name across argument fragments, so it's
   * the stable correlation signal. If a stream ever contains two calls
   * to the SAME function in parallel, this strategy collapses them;
   * Gemini does not appear to do that in practice.
   */
  const nameToIndex = new Map<string, number>();
  /** Monotonic counter for unseen function names. */
  let nextIndex = 0;

  function indexForToolCall(tc: ToolCallDelta, positional: number): number {
    // Prefer an existing, explicit index from the upstream.
    if (typeof tc.index === "number") return tc.index;

    const name = tc.function?.name;
    if (name != null && name.length > 0) {
      const cached = nameToIndex.get(name);
      if (cached != null) return cached;
      const next = nextIndex++;
      nameToIndex.set(name, next);
      return next;
    }

    // Fragment chunk with no name and no index. Common case: the first
    // chunk declared the function name and subsequent chunks carry only
    // argument fragments. Reuse the most recently minted index so the
    // fragments land on the same tool call.
    if (nextIndex > 0) return nextIndex - 1;

    // Absolute fallback: positional index within the current chunk.
    return positional;
  }

  return {
    transform(chunk: ChatCompletionChunk): ChatCompletionChunk[] {
      if (!chunk.choices || chunk.choices.length === 0) return [chunk];

      const patchedChoices: ChatCompletionChunkChoice[] = chunk.choices.map(
        (choice) => {
          const toolCalls = choice.delta?.tool_calls;
          if (!toolCalls || toolCalls.length === 0) return choice;

          const patchedToolCalls = toolCalls.map((tc, positional) => ({
            ...tc,
            index: indexForToolCall(tc, positional),
            // Some Gemini builds also omit `type`. The OpenAI spec
            // requires "function" on the first fragment only, but it's
            // cheap and harmless to stamp it on every fragment.
            type: tc.type ?? "function",
          }));

          return {
            ...choice,
            delta: {
              ...choice.delta,
              tool_calls: patchedToolCalls,
            },
          };
        },
      );

      return [{ ...chunk, choices: patchedChoices }];
    },
    flush(): ChatCompletionChunk[] {
      return [];
    },
  };
}
