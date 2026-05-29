import { describe, it, expect } from "vitest";
import {
  parseRetryAfter,
  toRetryAfterSeconds,
  MIN_RETRY_MS,
  MAX_RETRY_MS,
} from "../src/routing/retry-after.js";

describe("parseRetryAfter - integer seconds", () => {
  it("parses a normal integer value", () => {
    expect(parseRetryAfter("3")).toBe(3_000);
    expect(parseRetryAfter("60")).toBe(60_000);
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  it("trims whitespace", () => {
    expect(parseRetryAfter("  7  ")).toBe(7_000);
  });

  it("parses fractional seconds (some providers emit 1.5)", () => {
    expect(parseRetryAfter("1.5")).toBe(1_500);
    expect(parseRetryAfter("2.25")).toBe(2_250);
  });

  it("clamps values below the 1 second floor to 1 second", () => {
    expect(parseRetryAfter("0")).toBe(MIN_RETRY_MS);
    expect(parseRetryAfter("0.1")).toBe(MIN_RETRY_MS);
    expect(parseRetryAfter("-5")).toBe(MIN_RETRY_MS);
  });

  it("clamps absurdly high values to the 10 minute ceiling", () => {
    expect(parseRetryAfter("99999999")).toBe(MAX_RETRY_MS);
    expect(parseRetryAfter("1000000")).toBe(MAX_RETRY_MS);
    expect(parseRetryAfter("601")).toBe(MAX_RETRY_MS);
  });

  it("keeps values at the boundary intact", () => {
    expect(parseRetryAfter("600")).toBe(600_000);
    expect(parseRetryAfter("1")).toBe(1_000);
  });
});

describe("parseRetryAfter - HTTP-date", () => {
  it("parses an HTTP-date in the future", () => {
    // Fix the "now" reference so the test is deterministic.
    const now = Date.parse("2026-04-09T00:00:00Z");
    const future = "Thu, 09 Apr 2026 00:00:07 GMT";
    expect(parseRetryAfter(future, now)).toBe(7_000);
  });

  it("clamps a far-future HTTP-date to the ceiling", () => {
    const now = Date.parse("2026-04-09T00:00:00Z");
    const farFuture = "Thu, 09 Apr 2027 00:00:00 GMT";
    expect(parseRetryAfter(farFuture, now)).toBe(MAX_RETRY_MS);
  });

  it("clamps a past HTTP-date to the floor", () => {
    const now = Date.parse("2026-04-09T00:00:00Z");
    const past = "Thu, 08 Apr 2026 00:00:00 GMT";
    expect(parseRetryAfter(past, now)).toBe(MIN_RETRY_MS);
  });
});

describe("parseRetryAfter - invalid input", () => {
  it("returns null for missing header", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("   ")).toBeNull();
  });

  it("returns null for garbage text that is neither a number nor a date", () => {
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("pls wait")).toBeNull();
    expect(parseRetryAfter("Infinity")).toBeNull();
  });
});

describe("toRetryAfterSeconds", () => {
  it("rounds up to whole seconds", () => {
    expect(toRetryAfterSeconds(1)).toBe(1);
    expect(toRetryAfterSeconds(999)).toBe(1);
    expect(toRetryAfterSeconds(1_001)).toBe(2);
    expect(toRetryAfterSeconds(12_000)).toBe(12);
    expect(toRetryAfterSeconds(12_001)).toBe(13);
  });

  it("enforces a 1 second floor", () => {
    expect(toRetryAfterSeconds(0)).toBe(1);
    expect(toRetryAfterSeconds(-100)).toBe(1);
  });
});
