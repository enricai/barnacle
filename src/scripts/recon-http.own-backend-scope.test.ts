import { describe, expect, it } from "vitest";

import type { ReplayResult } from "@/scripts/recon-http";
import { selectRateLimitTargets, selectReplayCaptures } from "@/scripts/recon-http";

const r = (url: string, method = "GET"): ReplayResult => ({
  success: true,
  url,
  method,
  operationName: null,
  requestBody: null,
  sourceCapture: "c.json",
  replayStatus: 200,
  replayHeaders: {},
  replayBody: null,
  error: null,
});
const urls = (x: ReturnType<typeof selectRateLimitTargets>) => [...x.targets.keys()];

describe("recon-http own-backend scope", () => {
  it("excludes hosts outside ownBackendHostnames", () => {
    const out = selectRateLimitTargets(
      [r("https://api.site.com/a"), r("https://other.com/b")],
      ["api.site.com"],
      null
    );
    expect(urls(out)).toEqual(["https://api.site.com/a"]);
  });
  it("excludes loopback and link-local hosts", () => {
    const out = selectRateLimitTargets(
      [
        r("http://127.0.0.1/a"),
        r("http://[::1]/a"),
        r("http://169.254.169.254/a"),
        r("https://api.site.com/a"),
      ],
      [],
      "api.site.com"
    );
    expect(urls(out)).toEqual(["https://api.site.com/a"]);
  });
  it("keeps fallback-domain behaviour when none declared", () => {
    const out = selectRateLimitTargets(
      [r("https://www.site.com/a"), r("https://x.other.com/b")],
      [],
      "api.site.com"
    );
    expect(urls(out)).toEqual(["https://www.site.com/a"]);
  });
  it("does not replay POST without the flag, replays with it", () => {
    const cap = {
      filename: "p.json",
      capture: {
        timestamp: "2026-11-05T00:00:00.000Z",
        phase: "replay",
        method: "POST",
        url: "https://api.site.com/x",
        status: 200,
        requestHeaders: {},
        requestPostData: null,
        responseBody: null,
        operationName: null,
        query: null,
        variables: null,
      },
    };
    expect(selectReplayCaptures([cap], false).selected).toHaveLength(0);
    expect(selectReplayCaptures([cap], true).selected).toHaveLength(1);
  });
});

describe("selectRateLimitTargets relevance order", () => {
  it("orders submit, fold, JSON, rest", () => {
    const json = (u: string, m = "GET"): ReplayResult => ({
      ...r(u, m),
      replayHeaders: { "content-type": "application/json" },
    });
    const out = selectRateLimitTargets(
      [
        r("https://shop.example.com/page"),
        r("https://shop.example.com/beacon"),
        json("https://shop.example.com/api/submit"),
        json("https://shop.example.com/api/fold"),
        json("https://shop.example.com/api/other"),
      ],
      [],
      "shop.example.com",
      ["/api/submit", "/api/fold"]
    );
    expect(urls(out)).toEqual([
      "https://shop.example.com/api/submit",
      "https://shop.example.com/api/fold",
      "https://shop.example.com/api/other",
      "https://shop.example.com/page",
      "https://shop.example.com/beacon",
    ]);
  });
});
