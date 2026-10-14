import { describe, expect, it } from "vitest";

import {
  isTransientProviderError,
  summarizeAttemptTransience,
} from "@/scraper/transient-provider-error";

function withProps(message: string, props: Record<string, unknown>): Error {
  return Object.assign(new Error(message), props);
}

describe("isTransientProviderError", () => {
  it.each([
    "An internal server error occurred",
    "Overloaded",
    "502 Bad Gateway",
    "Service Unavailable",
    "socket hang up",
    "read ECONNRESET",
  ])("treats %s as transient", (message) => {
    expect(isTransientProviderError(new Error(message))).toBe(true);
  });

  it("uses structured status and code", () => {
    expect(isTransientProviderError(withProps("failed", { status: 503 }))).toBe(true);
    expect(isTransientProviderError(withProps("failed", { statusCode: 529 }))).toBe(true);
    expect(isTransientProviderError(withProps("failed", { status: 429 }))).toBe(true);
    expect(isTransientProviderError(withProps("failed", { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientProviderError(new Error("x", { cause: { status: 500 } }))).toBe(true);
  });

  it("lets a structured non-5xx status override message text", () => {
    expect(isTransientProviderError(withProps("internal server error", { status: 400 }))).toBe(
      false
    );
  });

  it.each([
    new Error("selector not found"),
    new Error("watchdog timeout after 30000ms waiting for https://example.com"),
    new Error("ZodError: schema validation failed"),
    withProps("bad request", { status: 400 }),
    "",
    undefined,
  ])("treats %s as non-transient", (err) => {
    expect(isTransientProviderError(err)).toBe(false);
  });
});

describe("summarizeAttemptTransience", () => {
  it("reports all/any", () => {
    expect(
      summarizeAttemptTransience([
        { errorMessage: "An internal server error occurred" },
        { errorMessage: "overloaded" },
      ])
    ).toEqual({ all: true, any: true });
    expect(
      summarizeAttemptTransience([
        { errorMessage: "overloaded" },
        { errorMessage: "selector not found" },
      ])
    ).toEqual({ all: false, any: true });
    expect(summarizeAttemptTransience([{ errorMessage: "selector not found" }])).toEqual({
      all: false,
      any: false,
    });
    expect(summarizeAttemptTransience([])).toEqual({ all: false, any: false });
  });
});
