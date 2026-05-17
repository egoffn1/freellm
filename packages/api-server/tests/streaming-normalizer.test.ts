/**
 * Fixture-based tests for the streaming normalizer pipeline.
 *
 * Every test feeds a captured upstream SSE trace through the
 * pipeline and asserts the parsed output against a canonical form,
 * rather than byte-equal, so trivial differences in JSON key order
 * do not cause false failures.
 *
 * Adding a new bug fix means:
 *   1. Drop an input fixture into tests/fixtures/sse/
 *   2. Write the expected parsed chunks inline in this file (or a
 *      separate fixture if the expected shape is long)
 *   3. Add a case below
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamingPipeline } from "../src/streaming/pipeline.js";
import { SSEParser } from "../src/streaming/sse.js";

const FIX_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sse");

function loadFixture(name: string): string {
  return readFileSync(path.join(FIX_DIR, name), "utf8");
}

/**
 * Run SSE text through the normalizer and return the parsed JSON
 * payloads from the resulting data events, in order. Comments and
 * [DONE] sentinels are captured as string markers so tests can
 * assert their presence and position.
 */
function runPipeline(
  input: string,
  providerId: string,
): Array<Record<string, unknown> | string> {
  const pipeline = new StreamingPipeline(providerId);
  const outputText = pipeline.push(input) + pipeline.flush();

  const parser = new SSEParser();
  const events = [...parser.push(outputText), ...parser.flush()];

  return events.map((e) => {
    if (e.type === "done") return "[DONE]";
    if (e.type === "comment") return `: ${e.text}`;
    return JSON.parse(e.data) as Record<string, unknown>;
  });
}

describe("Gemini normalizer: missing tool_call index", () => {
  it("fills index 0 on a single tool call and keeps it stable across argument fragments", () => {
    const input = loadFixture("gemini-missing-index.input.sse");
    const events = runPipeline(input, "gemini");

    // First chunk is a plain role assignment, untouched.
    expect(events[0]).toMatchObject({
      choices: [{ delta: { role: "assistant" } }],
    });

    // Second chunk introduces the tool call with name and arguments start.
    const second = events[1] as { choices: Array<{ delta: { tool_calls: unknown[] } }> };
    expect(second.choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        type: "function",
        function: { name: "search_web", arguments: '{"q' },
      },
    ]);

    // Third chunk is an argument fragment with neither name nor explicit
    // index. It should reuse the previously-minted index.
    const third = events[2] as { choices: Array<{ delta: { tool_calls: unknown[] } }> };
    expect(third.choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        type: "function",
        function: { arguments: '":"freellm"}' },
      },
    ]);

    // Final finish_reason chunk passes through.
    expect(events[3]).toMatchObject({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    });

    expect(events[events.length - 1]).toBe("[DONE]");
  });
});

describe("Gemini normalizer: multiple tool calls in parallel", () => {
  it("assigns distinct indices to different function names", () => {
    const input = loadFixture("gemini-multi-tool.input.sse");
    const events = runPipeline(input, "gemini");

    const first = events[0] as { choices: Array<{ delta: { tool_calls: unknown[] } }> };
    expect(first.choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
      },
    ]);

    const second = events[1] as { choices: Array<{ delta: { tool_calls: unknown[] } }> };
    expect(second.choices[0].delta.tool_calls).toEqual([
      {
        index: 1,
        type: "function",
        function: { name: "get_time", arguments: '{"tz":"JST"}' },
      },
    ]);
  });
});

describe("Gemini normalizer: mixed text and tool delta", () => {
  it("leaves plain content deltas untouched and still fixes the tool delta", () => {
    const input = loadFixture("gemini-mixed-text-tool.input.sse");
    const events = runPipeline(input, "gemini");

    // Content chunk survives unchanged.
    expect(events[0]).toMatchObject({
      choices: [{ delta: { role: "assistant", content: "Let me check that." } }],
    });

    // Tool delta picks up index and type.
    const toolEvent = events[1] as { choices: Array<{ delta: { tool_calls: unknown[] } }> };
    expect(toolEvent.choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        type: "function",
        function: { name: "lookup", arguments: "{}" },
      },
    ]);
  });
});

describe("Ollama normalizer: split arguments and missing fields", () => {
  it("keeps a stable index across argument fragment chunks", () => {
    const input = loadFixture("ollama-split-arguments.input.sse");
    const events = runPipeline(input, "ollama");

    // First chunk: declares the function with a name, no args yet.
    const first = events[0] as { choices: Array<{ delta: { tool_calls: unknown[] } }> };
    expect(first.choices[0].delta.tool_calls).toMatchObject([
      { index: 0, type: "function", function: { name: "read_file" } },
    ]);

    // Second chunk: argument fragment. Ollama puts `arguments` at the
    // top level of the tool_call rather than inside `function`. The
    // normalizer should hoist it into function.arguments.
    const second = events[1] as { choices: Array<{ delta: { tool_calls: unknown[] } }> };
    expect(second.choices[0].delta.tool_calls).toMatchObject([
      { index: 0, type: "function", function: { arguments: '{"path"' } },
    ]);
    // And the top-level `arguments` key is stripped.
    expect(second.choices[0].delta.tool_calls[0]).not.toHaveProperty("arguments");

    // Third chunk: another argument fragment, same index reuse.
    const third = events[2] as { choices: Array<{ delta: { tool_calls: unknown[] } }> };
    expect(third.choices[0].delta.tool_calls).toMatchObject([
      { index: 0, type: "function", function: { arguments: ':"/etc/hosts"}' } },
    ]);
  });
});

describe("Passthrough providers", () => {
  it("leaves a compliant Groq stream byte-for-byte equivalent in parsed form", () => {
    const input = loadFixture("passthrough-groq.input.sse");
    const events = runPipeline(input, "groq");

    expect(events[0]).toMatchObject({
      choices: [{ delta: { role: "assistant", content: "Hello" } }],
    });
    expect(events[1]).toMatchObject({
      choices: [{ delta: { content: " world" } }],
    });
    expect(events[2]).toMatchObject({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    expect(events[events.length - 1]).toBe("[DONE]");
  });
});

describe("Malformed chunk resilience", () => {
  it("passes a non-JSON data chunk through verbatim without crashing", () => {
    const pipeline = new StreamingPipeline("gemini");
    const input =
      'data: {"id":"ok","choices":[{"index":0,"delta":{"content":"a"}}]}\n\n' +
      "data: this is not json at all\n\n" +
      'data: {"id":"ok","choices":[{"index":0,"delta":{"content":"b"}}]}\n\n' +
      "data: [DONE]\n\n";

    const out = pipeline.push(input) + pipeline.flush();

    // The bad chunk should appear verbatim in the output.
    expect(out).toContain("this is not json at all");
    // Both valid chunks and [DONE] should still be present.
    expect(out).toContain('"content":"a"');
    expect(out).toContain('"content":"b"');
    expect(out).toContain("[DONE]");
  });
});
