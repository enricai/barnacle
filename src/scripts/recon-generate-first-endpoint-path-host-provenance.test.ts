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

describe("firstEndpointPath host provenance gate", () => {
  it("skips a chronologically-first third-party capture in favor of the own-backend capture", () => {
    const thirdParty = makeCapture({
      method: "POST",
      url: "https://sdk.thirdpartyanalytics.com/track/submit",
    });
    const ownBackend = makeCapture({
      method: "POST",
      url: "https://api.example.com/api/submit",
    });

    const endpointPath = firstEndpointPath(
      [thirdParty, ownBackend],
      ["api.example.com"],
      null
    );

    expect(endpointPath).toBe("/api/submit");
  });

  it("resolves via fallbackDomain when ownBackendHostnames is empty", () => {
    const thirdParty = makeCapture({
      method: "POST",
      url: "https://sdk.thirdpartyanalytics.com/track/submit",
    });
    const ownBackend = makeCapture({
      method: "POST",
      url: "https://api.example.com/api/submit",
    });

    const endpointPath = firstEndpointPath([thirdParty, ownBackend], [], "example.com");

    expect(endpointPath).toBe("/api/submit");
  });

  it("keeps the chronological-first behavior unchanged when no provenance args are passed", () => {
    const first = makeCapture({ method: "POST", url: "https://sdk.thirdpartyanalytics.com/track" });
    const second = makeCapture({ method: "POST", url: "https://api.example.com/api/submit" });

    expect(firstEndpointPath([first, second])).toBe("/track");
  });
});

describe("firstEndpointCapture host provenance gate", () => {
  it("never returns a numerically-dominant third-party capture over the own-backend capture", () => {
    const ownBackend = makeCapture({
      method: "POST",
      url: "https://api.example.com/api/submit",
    });
    const thirdPartyCaptures = Array.from({ length: 5 }, (_, i) =>
      makeCapture({
        method: "POST",
        url: `https://sdk.thirdpartyanalytics.com/track/${i}`,
      })
    );

    const result = firstEndpointCapture(
      [...thirdPartyCaptures, ownBackend],
      ["api.example.com"],
      null
    );

    expect(result).toBe(ownBackend);
  });

  it("keeps the chronological-first behavior unchanged when no provenance args are passed", () => {
    const first = makeCapture({ method: "POST", url: "https://sdk.thirdpartyanalytics.com/track" });
    const second = makeCapture({ method: "POST", url: "https://api.example.com/api/submit" });

    expect(firstEndpointCapture([first, second])).toBe(first);
  });
});
