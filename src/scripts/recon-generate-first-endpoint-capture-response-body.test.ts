import { describe, expect, it } from "vitest";
import { firstEndpointCapture, firstEndpointPath } from "@/scripts/recon-generate";
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

describe("firstEndpointCapture", () => {
  it("returns the same capture whose path firstEndpointPath resolves, so its responseBody stays in sync", () => {
    const landingPage = makeCapture({
      method: "GET",
      url: "https://example.com/apply",
    });
    const action = makeCapture({
      method: "POST",
      url: "https://example.com/api/apply/submit",
      responseBody: { jobId: "abc123" },
    });

    const capture = firstEndpointCapture([landingPage, action]);

    expect(capture).toBe(action);
    expect(capture?.responseBody).toEqual({ jobId: "abc123" });
    expect(new URL(capture?.url ?? "").pathname).toBe(firstEndpointPath([landingPage, action]));
  });

  it("returns null when no capture has a parseable URL, matching firstEndpointPath's '/api/search' fallback", () => {
    const invalid = makeCapture({ url: "not-a-valid-url" });

    expect(firstEndpointCapture([invalid])).toBeNull();
    expect(firstEndpointPath([invalid])).toBe("/api/search");
  });
});
