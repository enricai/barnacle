import { describe, expect, it } from "vitest";

import { getCookieValue } from "@/lib/cookie-value";

describe("lib/cookie-value getCookieValue", () => {
  it("returns the value for the named cookie", () => {
    expect(getCookieValue("datadome=abc123", "datadome")).toBe("abc123");
  });

  it("returns the value when the named cookie is not first", () => {
    expect(getCookieValue("session=xyz; datadome=abc123; foo=bar", "datadome")).toBe("abc123");
  });

  it("returns undefined when the cookie is absent", () => {
    expect(getCookieValue("session=xyz; foo=bar", "datadome")).toBeUndefined();
  });

  it("returns undefined for an empty cookie string", () => {
    expect(getCookieValue("", "datadome")).toBeUndefined();
  });

  it("returns the full value up to the next semicolon", () => {
    const long = "a".repeat(128);
    expect(getCookieValue(`datadome=${long}; other=val`, "datadome")).toBe(long);
  });

  it("works for cookie names other than datadome", () => {
    expect(getCookieValue("token=secret; other=val", "token")).toBe("secret");
  });
});
