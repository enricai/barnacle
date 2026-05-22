import { describe, expect, it } from "vitest";

import { toErrorMessage } from "@/lib/errors";

describe("lib/errors toErrorMessage", () => {
  it("surfaces the message of a real Error instance", () => {
    expect(toErrorMessage(new Error("msg"))).toBe("msg");
  });

  it("surfaces subclass Error messages too", () => {
    expect(toErrorMessage(new TypeError("type oops"))).toBe("type oops");
  });

  it("returns the value verbatim when handed a string", () => {
    expect(toErrorMessage("string")).toBe("string");
  });

  it("stringifies null", () => {
    expect(toErrorMessage(null)).toBe("null");
  });

  it("stringifies undefined", () => {
    expect(toErrorMessage(undefined)).toBe("undefined");
  });

  it("stringifies numeric thrown values", () => {
    expect(toErrorMessage(42)).toBe("42");
  });

  it("stringifies plain objects via String(value)", () => {
    expect(toErrorMessage({ foo: "bar" })).toBe("[object Object]");
  });
});
