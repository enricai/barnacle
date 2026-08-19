import { describe, expect, it } from "vitest";
import { firstEndpointPath } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function makeCapture(overrides: Partial<Capture>): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/submit",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
    ...overrides,
  };
}

describe("firstEndpointPath", () => {
  it("skips a leading GET navigation capture in favor of a non-GET action capture", () => {
    const landingPage = makeCapture({ method: "GET", url: "https://example.com/apply" });
    const submission = makeCapture({ method: "POST", url: "https://example.com/api/submit" });

    expect(firstEndpointPath([landingPage, submission])).toBe("/api/submit");
  });

  it("falls back to the GET-derived path only when no non-GET capture exists", () => {
    const landingPage = makeCapture({ method: "GET", url: "https://example.com/apply" });

    expect(firstEndpointPath([landingPage])).toBe("/apply");
  });

  it("returns the first non-GET capture even when it appears after several GETs", () => {
    const first = makeCapture({ method: "GET", url: "https://example.com/" });
    const second = makeCapture({ method: "GET", url: "https://example.com/apply" });
    const submission = makeCapture({ method: "PUT", url: "https://example.com/api/update" });

    expect(firstEndpointPath([first, second, submission])).toBe("/api/update");
  });
});
