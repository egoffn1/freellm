/**
 * Ollama streaming normalizer.
 *
 * Ollama's own maintainers describe its streaming tool-call emission
 * as "incomplete and inconsistent" (github.com/ollama/ollama/issues/12557).
 * The specific failure modes we observe:
 *
 *   1. Tool call delta chunks sometimes omit `index` entirely.
 *   2. Some chunks omit `type: "function"` on what should be the first
 *      fragment of a tool call.
 *   3. Argument fragments arrive in separate chunks without the
 *      wrapping `function` object, just loose `arguments` strings.
 *   4. Ollama occasionally emits a chunk containing ONLY finish_reason
 *      and no delta at all, which is technically valid but unusual.
 *
 * This normalizer targets the first three. The fourth is already
 * handled correctly by every OpenAI client so we pass it through.
 *
 * Like the Gemini normalizer this keeps per-stream state so fragment
 * chunks end up on the same logical tool call.
 */
import type {
  ChatCompletionChunk,
  ChatCompletionChunkChoice,
  Normalizer,
  ToolCallDelta,
} from "./types.js";

export function createOllamaNormalizer(): Normalizer {
  /** Track the index we last used so fragments reuse it. */
  let lastIndex = 0;
  /** True once we've seen at least one tool_call delta in this stream. */
  let seenToolCall = false;

  function fixToolCall(tc: ToolCallDelta, positional: number): ToolCallDelta {
    // Resolve the index. Explicit upstream index wins.
    let index: number;
    if (typeof tc.index === "number") {
      index = tc.index;
    } else if (!seenToolCall) {
      index = positional;
    } else {
      // Subsequent fragment with no index reuses the last one, which
      // matches how OpenAI clients reassemble argument strings.
      index = lastIndex;
    }

    seenToolCall = true;
    lastIndex = index;

    // Ensure the wrapping `function` object exists. Ollama sometimes
    // flattens arguments onto the tool_call directly as if they were
    // top-level fields. Hoist them into the expected shape.
    const fn = tc.function ?? {};
    const topLevelArgs = (tc as { arguments?: unknown }).arguments;
    const patchedFunction = {
      ...fn,
      ...(typeof topLevelArgs === "string" && fn.arguments == null
        ? { arguments: topLevelArgs }
        : {}),
    };

    const result: ToolCallDelta = {
      ...tc,
      index,
      type: tc.type ?? "function",
      function: patchedFunction,
    };
    // If we hoisted `arguments`, strip the top-level copy.
    if (typeof topLevelArgs === "string") {
      delete (result as Record<string, unknown>)["arguments"];
    }
    return result;
  }

  return {
    transform(chunk: ChatCompletionChunk): ChatCompletionChunk[] {
      if (!chunk.choices || chunk.choices.length === 0) return [chunk];

      const patchedChoices: ChatCompletionChunkChoice[] = chunk.choices.map(
        (choice) => {
          const toolCalls = choice.delta?.tool_calls;
          if (!toolCalls || toolCalls.length === 0) return choice;

          const patched = toolCalls.map((tc, i) => fixToolCall(tc, i));

          return {
            ...choice,
            delta: {
              ...choice.delta,
              tool_calls: patched,
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
