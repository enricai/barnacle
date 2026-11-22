import { describe, expect, it } from "vitest";

import type { ReplayResult } from "@/scripts/recon-http";
import { bodyTypeDiffers, selectRateLimitTargets } from "@/scripts/recon-http";

const r = (url: string, contentType?: string): ReplayResult => ({
  success: true,
  url,
  method: "GET",
  operationName: null,
  requestBody: null,
  sourceCapture: "c.json",
  replayStatus: 200,
  replayHeaders: contentType ? { "content-type": contentType } : {},
  replayBody: null,
  error: null,
});

describe("selectRateLimitTargets relevance ordering", () => {
  it("orders submit pattern, foldReturn pattern, JSON, then others", () => {
    const out = selectRateLimitTargets(
      [
        r("https://api.site.com/other", "text/html"),
        r("https://api.site.com/data", "application/json"),
        r("https://api.site.com/fold", "text/html"),
        r("https://api.site.com/submit", "text/html"),
      ],
      ["api.site.com"],
      null,
      ["/fold", "/submit"],
      "/submit"
    );
    expect([...out.targets.keys()]).toEqual([
      "https://api.site.com/submit",
      "https://api.site.com/fold",
      "https://api.site.com/data",
      "https://api.site.com/other",
    ]);
  });
});

describe("bodyTypeDiffers", () => {
  it("flags JSON vs non-JSON in either direction", () => {
    expect(bodyTypeDiffers('{"a":1}', "<html></html>")).toBe(true);
    expect(bodyTypeDiffers("<html></html>", '{"a":1}')).toBe(true);
  });
  it("is false when types match or captured is null", () => {
    expect(bodyTypeDiffers('{"a":1}', '{"b":2}')).toBe(false);
    expect(bodyTypeDiffers(null, "<html></html>")).toBe(false);
  });
});
