import { describe, expect, it } from "vitest";

import { matchUrlCaptureGroup } from "@/lib/url-capture";

describe("matchUrlCaptureGroup", () => {
  it("returns the first capture group on a successful match", () => {
    const url = "https://apply.acme.example/jobs/123456/apply-portal/apply";
    const result = matchUrlCaptureGroup(url, /\/jobs\/(\d+)\//, () => {
      throw new Error("should not be called");
    });
    expect(result).toBe("123456");
  });

  it("returns capture group 1, not group 0 (the full match)", () => {
    const url = "https://example.com/j-AbCd123";
    const result = matchUrlCaptureGroup(url, /j-([A-Za-z0-9]+)/, () => {
      throw new Error("should not be called");
    });
    expect(result).toBe("AbCd123");
    expect(result).not.toBe("j-AbCd123");
  });

  it("captures jobId from URL without trailing slash (query-string terminated)", () => {
    const url = "https://apply.acme.example/jobs/44654507943?cs=sy3&exch=7t&jg=6rf0";
    const result = matchUrlCaptureGroup(url, /\/jobs\/(\d+)/, () => {
      throw new Error("should not be called");
    });
    expect(result).toBe("44654507943");
  });

  it("captures jobId from URL with trailing slash", () => {
    const url = "https://apply.acme.example/jobs/123456/apply-portal/apply";
    const result = matchUrlCaptureGroup(url, /\/jobs\/(\d+)/, () => {
      throw new Error("should not be called");
    });
    expect(result).toBe("123456");
  });

  it("invokes onMiss when the pattern does not match", () => {
    const url = "https://example.com/no-match-here";
    class SentinelError extends Error {}
    expect(() =>
      matchUrlCaptureGroup(url, /\/jobs\/(\d+)\//, () => {
        throw new SentinelError("no match");
      })
    ).toThrow(SentinelError);
  });

  it("invokes onMiss when the pattern matches but has no capture group", () => {
    const url = "https://example.com/jobs/";
    class SentinelError extends Error {}
    expect(() =>
      matchUrlCaptureGroup(url, /\/jobs\//, () => {
        throw new SentinelError("no capture group");
      })
    ).toThrow(SentinelError);
  });
});
