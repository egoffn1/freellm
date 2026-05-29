import { describe, expect, it } from "vitest";
import { SSEParser, serializeEvent, serializeHeartbeat } from "../src/streaming/sse.js";

describe("SSEParser", () => {
  it("parses a single complete event", () => {
    const p = new SSEParser();
    const events = p.push('data: {"a":1}\n\n');
    expect(events).toEqual([{ type: "data", data: '{"a":1}' }]);
  });

  it("parses multiple events in one push", () => {
    const p = new SSEParser();
    const events = p.push('data: {"a":1}\n\ndata: {"a":2}\n\n');
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "data", data: '{"a":1}' });
    expect(events[1]).toEqual({ type: "data", data: '{"a":2}' });
  });

  it("buffers a partial event across two pushes", () => {
    const p = new SSEParser();
    expect(p.push('data: {"a":')).toEqual([]);
    const events = p.push("1}\n\n");
    expect(events).toEqual([{ type: "data", data: '{"a":1}' }]);
  });

  it("recognizes [DONE] sentinel", () => {
    const p = new SSEParser();
    expect(p.push("data: [DONE]\n\n")).toEqual([{ type: "done" }]);
  });

  it("recognizes comment lines as heartbeats", () => {
    const p = new SSEParser();
    expect(p.push(": keep-alive\n\n")).toEqual([{ type: "comment", text: "keep-alive" }]);
  });

  it("normalizes CRLF line endings", () => {
    const p = new SSEParser();
    const events = p.push('data: {"a":1}\r\n\r\n');
    expect(events).toEqual([{ type: "data", data: '{"a":1}' }]);
  });

  it("ignores unknown field lines without breaking", () => {
    const p = new SSEParser();
    const events = p.push('event: custom\ndata: {"ok":true}\nid: 42\n\n');
    expect(events).toEqual([{ type: "data", data: '{"ok":true}' }]);
  });

  it("flush drains a trailing event without a blank line", () => {
    const p = new SSEParser();
    expect(p.push('data: {"a":1}')).toEqual([]);
    expect(p.flush()).toEqual([{ type: "data", data: '{"a":1}' }]);
  });

  it("returns empty on flush when buffer is already drained", () => {
    const p = new SSEParser();
    p.push('data: {"a":1}\n\n');
    expect(p.flush()).toEqual([]);
  });
});

describe("serializeEvent", () => {
  it("serializes a data event", () => {
    expect(serializeEvent({ type: "data", data: '{"a":1}' })).toBe('data: {"a":1}\n\n');
  });

  it("serializes [DONE]", () => {
    expect(serializeEvent({ type: "done" })).toBe("data: [DONE]\n\n");
  });

  it("serializes a comment", () => {
    expect(serializeEvent({ type: "comment", text: "ping" })).toBe(": ping\n\n");
  });

  it("splits multi-line data across data: lines", () => {
    const out = serializeEvent({ type: "data", data: "line1\nline2" });
    expect(out).toBe("data: line1\ndata: line2\n\n");
  });
});

describe("serializeHeartbeat", () => {
  it("emits a well-formed SSE comment", () => {
    expect(serializeHeartbeat()).toBe(": keep-alive\n\n");
  });

  it("accepts custom text", () => {
    expect(serializeHeartbeat("tick")).toBe(": tick\n\n");
  });
});
