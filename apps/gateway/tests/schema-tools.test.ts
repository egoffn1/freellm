/**
 * Regression tests for the chat completion Zod schema.
 *
 * This file specifically exercises the OpenAI request shapes a real
 * caller will send when using tool-calling, streaming options, and
 * the broader set of optional fields. The schema is `.strict()`
 * which means any field we forget to declare will throw a 400 at
 * the validate middleware before the request ever reaches the
 * router, so these tests are the backstop that catches it.
 */
import { describe, expect, it } from "vitest";
import { chatCompletionRequestSchema } from "../src/schemas.js";

function ok(body: unknown) {
  const result = chatCompletionRequestSchema.safeParse(body);
  if (!result.success) {
    throw new Error(
      `expected schema to accept body, got error: ${JSON.stringify(result.error.issues)}`,
    );
  }
  return result.data;
}

function rejects(body: unknown) {
  const result = chatCompletionRequestSchema.safeParse(body);
  expect(result.success).toBe(false);
}

describe("chatCompletionRequestSchema", () => {
  it("accepts a minimal body", () => {
    ok({
      model: "free",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("accepts a tool-calling request with tools and tool_choice", () => {
    ok({
      model: "free-fast",
      messages: [{ role: "user", content: "weather in Tokyo" }],
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
  });

  it("accepts tool_choice as a specific function reference", () => {
    ok({
      model: "free",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          type: "function",
          function: { name: "lookup" },
        },
      ],
      tool_choice: { type: "function", function: { name: "lookup" } },
    });
  });

  it("accepts a multi-turn conversation with a tool response", () => {
    ok({
      model: "free",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather in Tokyo?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: '{"temp_c": 18, "conditions": "clear"}',
        },
      ],
    });
  });

  it("accepts stream_options with include_usage", () => {
    ok({
      model: "free",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("accepts response_format json_object", () => {
    ok({
      model: "free",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    });
  });

  it("accepts response_format json_schema with nested schema", () => {
    ok({
      model: "free",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "weather",
          schema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      },
    });
  });

  it("accepts the full optional-field set", () => {
    ok({
      model: "free",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
      max_completion_tokens: 256,
      temperature: 0.7,
      top_p: 0.9,
      stop: ["\n\n", "END"],
      presence_penalty: 0.2,
      frequency_penalty: 0.3,
      seed: 42,
      user: "user-1",
    });
  });

  it("accepts reasoning_effort at every allowed level", () => {
    for (const level of ["none", "low", "medium", "high"] as const) {
      ok({
        model: "gemini/gemini-2.5-flash",
        messages: [{ role: "user", content: "think" }],
        reasoning_effort: level,
      });
    }
  });

  it("rejects an unknown reasoning_effort value", () => {
    rejects({
      model: "free",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "maximal",
    });
  });

  it("accepts the developer role (used by newer OpenAI models)", () => {
    ok({
      model: "free",
      messages: [
        { role: "developer", content: "Internal instructions." },
        { role: "user", content: "hi" },
      ],
    });
  });

  it("still rejects unknown top-level keys in strict mode", () => {
    rejects({
      model: "free",
      messages: [{ role: "user", content: "hi" }],
      made_up_field: true,
    });
  });

  it("still rejects tools[].type other than function", () => {
    rejects({
      model: "free",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "shell", function: { name: "ls" } }],
    });
  });

  it("still rejects malformed tool_choice strings", () => {
    rejects({
      model: "free",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "maybe",
    });
  });
});
