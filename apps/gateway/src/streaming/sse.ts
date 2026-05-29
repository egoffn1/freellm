/**
 * Server-Sent Events primitives used by the streaming normalizer.
 *
 * Why a custom parser? We receive upstream streams as arbitrary TCP
 * chunks from `fetch()` and Node's WHATWG ReadableStream reader. Those
 * chunks can split an SSE event across multiple reads (e.g. half an
 * event in chunk N and the other half in chunk N+1) so we need a
 * small stateful accumulator that emits complete events only.
 *
 * SSE on the wire looks like this:
 *
 *     data: {"id": "chatcmpl-1", "choices": [...]}
 *
 *     data: {"id": "chatcmpl-1", "choices": [...]}
 *
 *     data: [DONE]
 *
 * Each event is terminated by a blank line. A line starting with `:`
 * is a comment (used for keep-alive heartbeats). The special payload
 * `[DONE]` is not JSON and must be preserved verbatim.
 *
 * This module intentionally knows nothing about OpenAI chunk shape. It
 * just parses events and exposes the raw `data:` payload as a string
 * so callers can JSON-parse it (or not) themselves.
 */

export type SSEEvent =
  /** `data: {json...}` event. `data` is the raw string AFTER any `data: ` prefix. */
  | { type: "data"; data: string }
  /** `data: [DONE]` sentinel. OpenAI uses this to close a completion stream. */
  | { type: "done" }
  /** `: ...` comment (heartbeat). `text` is the payload after `:`. */
  | { type: "comment"; text: string };

/**
 * Incrementally parse SSE bytes from an upstream. Create one instance
 * per upstream response and call `push()` with every chunk of decoded
 * text you receive. It returns the list of complete events available
 * so far, buffering any partial trailing event until more data arrives.
 *
 * Call `flush()` after the upstream closes to drain any final complete
 * event that did NOT end with a blank line (some providers are sloppy).
 */
export class SSEParser {
  private buffer = "";

  push(text: string): SSEEvent[] {
    this.buffer += text;
    const events: SSEEvent[] = [];

    // SSE events are terminated by `\n\n`. Windows-style `\r\n\r\n` is
    // also valid per the spec. We normalize on `\n\n` by pre-replacing
    // CRLF sequences so the splitter only needs one case.
    this.buffer = this.buffer.replace(/\r\n/g, "\n");

    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = parseEventBlock(rawEvent);
      if (parsed) events.push(parsed);
      boundary = this.buffer.indexOf("\n\n");
    }
    return events;
  }

  /**
   * Drain any final event left in the buffer after the upstream closes.
   * Returns zero or one events depending on whether the final block
   * was a complete-enough event.
   */
  flush(): SSEEvent[] {
    if (this.buffer.trim().length === 0) return [];
    const parsed = parseEventBlock(this.buffer);
    this.buffer = "";
    return parsed ? [parsed] : [];
  }
}

/**
 * Parse a single event block (the text between two `\n\n` boundaries).
 * A block can contain multiple lines; only the `data:` lines are
 * concatenated together per the SSE spec. Returns null for empty
 * blocks or blocks that only contain headers we do not use.
 */
function parseEventBlock(block: string): SSEEvent | null {
  const lines = block.split("\n");
  const dataLines: string[] = [];
  let commentText: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) continue;
    if (line.startsWith(":")) {
      // Comment. Keep the first one we see for observability.
      if (commentText === null) commentText = line.slice(1).trimStart();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    // event:, id:, retry: — not used by any of our providers. Ignore.
  }

  if (dataLines.length === 0) {
    if (commentText !== null) return { type: "comment", text: commentText };
    return null;
  }

  const data = dataLines.join("\n");
  if (data === "[DONE]") return { type: "done" };
  return { type: "data", data };
}

/**
 * Serialize an SSE event back into its wire-format string, including
 * the trailing blank line that terminates the event. The return value
 * is ready to be written directly to a Node `res.write()` call.
 */
export function serializeEvent(event: SSEEvent): string {
  switch (event.type) {
    case "done":
      return "data: [DONE]\n\n";
    case "data":
      // If the data is multi-line (unlikely but allowed by spec), prefix
      // each line with `data: ` so the client reassembles it correctly.
      return (
        event.data
          .split("\n")
          .map((line) => `data: ${line}`)
          .join("\n") + "\n\n"
      );
    case "comment":
      return `: ${event.text}\n\n`;
  }
}

/** Convenience helper used by the chat route heartbeat. */
export function serializeHeartbeat(text = "keep-alive"): string {
  return `: ${text}\n\n`;
}
