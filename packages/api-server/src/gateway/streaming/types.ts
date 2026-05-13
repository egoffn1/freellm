/**
 * Minimal shape of an OpenAI streaming chat completion chunk. We only
 * type the fields the normalizer actually inspects or mutates; every
 * other field passes through untouched via object spread.
 */
export interface ChatCompletionChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: ToolCallDelta[];
  [k: string]: unknown;
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: "function" | string;
  function?: {
    name?: string;
    arguments?: string;
  };
  [k: string]: unknown;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason?: string | null;
  [k: string]: unknown;
}

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatCompletionChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: ChatCompletionChunkChoice[];
  usage?: StreamUsage;
  [k: string]: unknown;
}

/**
 * A Normalizer is a stateful per-stream object. Create one for every
 * upstream response and call `transform(chunk)` for each parsed chunk.
 * It may return zero or more chunks depending on whether it's merging,
 * splitting, or rewriting.
 */
export interface Normalizer {
  /** Transform a single OpenAI streaming chunk. Returns the chunks to emit. */
  transform(chunk: ChatCompletionChunk): ChatCompletionChunk[];
  /** Drain any buffered state when the upstream stream ends. */
  flush(): ChatCompletionChunk[];
}
