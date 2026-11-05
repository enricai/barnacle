import { describe, expect, it } from "vitest";

import { type ReplayResult, selectRateLimitTargets } from "./recon-http";

function replay(url: string): ReplayResult {
  return {
    sourceCapture: "000-capture.json",
    url,
    method: "GET",
    operationName: null,
    requestBody: null,
    replayStatus: 200,
    replayHeaders: {},
    replayBody: {},
    success: true,
    error: null,
  };
}

const replays = [
  replay("https://example.com/api/a"),
  replay("https://api.example.com/api/b"),
  replay("https://thirdparty.example.net/api/c"),
  replay("https://notexample.com/api/d"),
  replay("https://example.com.evil.example.org/api/e"),
];

describe("selectRateLimitTargets — own hosts only", () => {
  it("keeps declared own hosts and their subdomains, drops third parties", () => {
    const { targets } = selectRateLimitTargets(replays, ["example.com"]);
    expect(Array.from(targets.keys())).toEqual([
      "https://example.com/api/a",
      "https://api.example.com/api/b",
    ]);
  });

  it("falls back to the run's registrable domain when no own hosts are declared", () => {
    const { targets } = selectRateLimitTargets(replays, [], "www.example.com");
    expect(Array.from(targets.keys())).toEqual([
      "https://example.com/api/a",
      "https://api.example.com/api/b",
    ]);
  });

  it("probes nothing when neither own hosts nor a fallback host is known", () => {
    expect(selectRateLimitTargets(replays, []).targets.size).toBe(0);
  });
});
