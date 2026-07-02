import { describe, expect, it } from "vitest";

import { lookupHeaderCaseInsensitive } from "@/lib/case-insensitive-headers";

describe("lib/case-insensitive-headers lookupHeaderCaseInsensitive", () => {
  it("returns the value for an exact-case match", () => {
    const headers = { "Content-Type": "application/json" };
    expect(lookupHeaderCaseInsensitive(headers, "Content-Type")).toBe("application/json");
  });

  it("returns the value when the lookup name differs in case from the stored key", () => {
    const headers = { "User-Agent": "Mozilla/5.0" };
    expect(lookupHeaderCaseInsensitive(headers, "user-agent")).toBe("Mozilla/5.0");
  });

  it("returns the value when the stored key differs in case from the lookup name", () => {
    const headers = { "x-xsrf-token": "abc123" };
    expect(lookupHeaderCaseInsensitive(headers, "X-XSRF-TOKEN")).toBe("abc123");
  });

  it("returns undefined for a missing header", () => {
    const headers = { "Content-Type": "application/json" };
    expect(lookupHeaderCaseInsensitive(headers, "Authorization")).toBeUndefined();
  });

  it("returns undefined for an empty record", () => {
    expect(lookupHeaderCaseInsensitive({}, "Content-Type")).toBeUndefined();
  });
});
