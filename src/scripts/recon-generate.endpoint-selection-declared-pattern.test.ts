import { describe, expect, it } from "vitest";
import { firstEndpointCapture } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function cap(o: Partial<Capture>): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "browse",
    method: "GET",
    url: "https://example.com/x",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
    ...o,
  };
}

describe("firstEndpointCapture declared pattern", () => {
  const pats = { endpoint: "/api/search", body: null };
  it("bot-sensor POST does not beat declared-pattern GET", () => {
    const post = cap({ method: "POST", url: "https://example.com/sensor" });
    const get = cap({ url: "https://example.com/api/search?q=a" });
    expect(firstEndpointCapture([post, get], [], null, pats)).toBe(get);
  });
  it("picks richest-query GET among same-pattern GETs", () => {
    const a = cap({ url: "https://example.com/api/search?q=a" });
    const b = cap({ url: "https://example.com/api/search?q=a&page=2&sort=x" });
    expect(firstEndpointCapture([a, b], [], null, pats)).toBe(b);
  });
  it("still prefers non-GET inside the pattern", () => {
    const get = cap({ url: "https://example.com/api/search?q=a" });
    const post = cap({ method: "POST", url: "https://example.com/api/search" });
    expect(firstEndpointCapture([get, post], [], null, pats)).toBe(post);
  });
});
