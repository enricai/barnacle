import { describe, expect, it } from "vitest";
import type { Capture, RateLimitFinding, ReplayResult } from "@/scripts/recon-shared";
import { buildUniqueEndpoints, detectHazards, formatDate } from "@/scripts/recon-summarize";

function makeCapture(overrides: Partial<Capture>): Capture {
  return {
    timestamp: "2026-01-15T12:00:00.000Z",
    phase: "graphql",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: null,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
    ...overrides,
  };
}

function makeReplay(overrides: Partial<ReplayResult>): ReplayResult {
  return {
    sourceCapture: "capture.json",
    url: "https://example.com/graphql",
    method: "POST",
    operationName: null,
    requestBody: null,
    replayStatus: 200,
    replayHeaders: {},
    replayBody: null,
    success: true,
    error: null,
    ...overrides,
  };
}

function makeRateLimitFinding(overrides: Partial<RateLimitFinding>): RateLimitFinding {
  return {
    endpoint: "https://example.com/graphql",
    safeRps: null,
    triggerStatus: null,
    triggerRps: null,
    retryAfter: null,
    xRateLimitHeaders: {},
    ...overrides,
  };
}

describe("formatDate", () => {
  it("renders a UTC medium-date/short-time string", () => {
    expect(formatDate("2026-01-15T12:34:00.000Z")).toBe("Jan 15, 2026, 12:34 PM");
  });
});

describe("buildUniqueEndpoints", () => {
  it("dedupes by origin+pathname while accumulating methods and operation names", () => {
    const captures = [
      makeCapture({
        url: "https://example.com/graphql?x=1",
        method: "POST",
        operationName: "GetUser",
      }),
      makeCapture({
        url: "https://example.com/graphql?x=2",
        method: "GET",
        operationName: "ListUsers",
      }),
      makeCapture({
        url: "https://example.com/other",
        method: "POST",
        operationName: null,
      }),
    ];

    const result = buildUniqueEndpoints(captures);

    expect(result.size).toBe(2);
    const graphql = result.get("https://example.com/graphql");
    expect(graphql?.methods).toEqual(new Set(["POST", "GET"]));
    expect(graphql?.operations).toEqual(new Set(["GetUser", "ListUsers"]));
    const other = result.get("https://example.com/other");
    expect(other?.methods).toEqual(new Set(["POST"]));
    expect(other?.operations).toEqual(new Set());
  });

  it("skips captures with unparseable URLs", () => {
    const captures = [makeCapture({ url: "not-a-url" })];
    expect(buildUniqueEndpoints(captures).size).toBe(0);
  });
});

describe("detectHazards", () => {
  it("flags 401 auth-required hazards", () => {
    const replays = [makeReplay({ replayStatus: 401, success: false })];
    expect(detectHazards(replays, [])).toEqual(["Auth required on some endpoints (401)"]);
  });

  it("flags 403 bot-detection hazards", () => {
    const replays = [makeReplay({ replayStatus: 403, success: false })];
    expect(detectHazards(replays, [])).toEqual([
      "Bot detection active on some endpoints (403) — may need more headers or Stagehand-only",
    ]);
  });

  it("flags Akamai edge detection from rate-limit headers", () => {
    const findings = [
      makeRateLimitFinding({ xRateLimitHeaders: { "X-Akamai-Session-Info": "1" } }),
    ];
    expect(detectHazards([], findings)).toEqual(["Akamai edge detected"]);
  });

  it("flags Cloudflare edge detection from rate-limit headers", () => {
    const findings = [makeRateLimitFinding({ xRateLimitHeaders: { "cf-ray": "abc123" } })];
    expect(detectHazards([], findings)).toEqual(["Cloudflare edge detected"]);
  });

  it("returns no hazards when nothing is detected", () => {
    const replays = [makeReplay({ replayStatus: 200, success: true })];
    expect(detectHazards(replays, [])).toEqual([]);
  });
});
