import { describe, expect, it } from "vitest";

import {
  lookupHeaderCaseInsensitive,
  omitHeaderCaseInsensitive,
} from "@/lib/case-insensitive-headers";

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

describe("lib/case-insensitive-headers omitHeaderCaseInsensitive", () => {
  it("removes the key when the stored key matches exactly", () => {
    const headers = { "Content-Type": "text/plain", Authorization: "Bearer x" };
    expect(omitHeaderCaseInsensitive(headers, "Content-Type")).toEqual({
      Authorization: "Bearer x",
    });
  });

  it("removes the key when the stored key has different capitalisation", () => {
    const headers = { "content-type": "text/plain", Authorization: "Bearer x" };
    expect(omitHeaderCaseInsensitive(headers, "Content-Type")).toEqual({
      Authorization: "Bearer x",
    });
  });

  it("removes the key when the name argument has different capitalisation", () => {
    const headers = { "Content-Type": "text/plain", Authorization: "Bearer x" };
    expect(omitHeaderCaseInsensitive(headers, "content-type")).toEqual({
      Authorization: "Bearer x",
    });
  });

  it("leaves the record unchanged when the named key is absent", () => {
    const headers = { Authorization: "Bearer x" };
    expect(omitHeaderCaseInsensitive(headers, "Content-Type")).toEqual({
      Authorization: "Bearer x",
    });
  });

  it("returns an empty record when the input has only the named key", () => {
    expect(omitHeaderCaseInsensitive({ "Content-Type": "text/plain" }, "content-type")).toEqual({});
  });

  it("returns an empty record for an empty input", () => {
    expect(omitHeaderCaseInsensitive({}, "Content-Type")).toEqual({});
  });

  it("does not mutate the original record", () => {
    const headers = { "Content-Type": "text/plain", Authorization: "Bearer x" };
    omitHeaderCaseInsensitive(headers, "Content-Type");
    expect(headers).toEqual({ "Content-Type": "text/plain", Authorization: "Bearer x" });
  });
});
