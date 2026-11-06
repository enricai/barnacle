import { describe, expect, it } from "vitest";
import type { RateLimitFinding, ReplayResult } from "@/scripts/recon-shared";
import { detectHazards, filterOwnHostRateLimits, hasBotDetection } from "@/scripts/recon-summarize";

const rl = (endpoint: string, h: Record<string, string> = {}): RateLimitFinding => ({
  endpoint,
  safeRps: 1,
  triggerStatus: null,
  triggerRps: null,
  retryAfter: null,
  xRateLimitHeaders: h,
});

describe("bot detection consistency", () => {
  it("edge hazard implies bot detection", () => {
    const f = [rl("https://a.com/x", { "x-akamai-foo": "1" })];
    expect(detectHazards([], f)).toContain("Akamai edge detected");
    expect(hasBotDetection([], f)).toBe(true);
    expect(hasBotDetection([], [])).toBe(false);
  });
  it("rate-limit keeps own-host only", () => {
    const replays = [{ url: "https://a.com/g", replayStatus: 200 } as ReplayResult];
    const out = filterOwnHostRateLimits(
      [rl("https://a.com/x"), rl("https://cdn.other.com/y")],
      replays
    );
    expect(out.map((f) => f.endpoint)).toEqual(["https://a.com/x"]);
  });
});
