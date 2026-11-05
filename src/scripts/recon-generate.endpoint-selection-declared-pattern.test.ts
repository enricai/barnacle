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

describe("firstEndpointCapture without a declared pattern", () => {
  const json = { "content-type": "application/json" };
  it("recurring sensor POSTs with no business data do not beat the GET search", () => {
    const sensors = [1, 2, 3].map((i) =>
      cap({
        method: "POST",
        url: "https://example.com/assets/sensor-endpoint",
        requestPostData: `{"sensor_data":"blob-${i}"}`,
        responseHeaders: json,
        responseBody: {},
      })
    );
    const get = cap({
      url: "https://example.com/api/search?q=a&limit=10",
      responseHeaders: json,
      responseBody: { results: [{ id: 7, title: "alpha" }] },
    });
    expect(firstEndpointCapture([...sensors, get], [], null, null)).toBe(get);
  });
  it("a one-off POST submission still wins over a GET read", () => {
    const get = cap({ url: "https://example.com/api/form?id=1" });
    const post = cap({ method: "POST", url: "https://example.com/api/submit", requestPostData: "{}" });
    expect(firstEndpointCapture([get, post], [], null, null)).toBe(post);
  });
  it("a recurring POST that returns business data stays the primary", () => {
    const posts = [1, 2].map((i) =>
      cap({
        method: "POST",
        url: "https://example.com/api/search",
        requestPostData: `{"q":"${i}"}`,
        responseHeaders: json,
        responseBody: { results: [{ id: i, title: `t${i}` }] },
      })
    );
    const get = cap({ url: "https://example.com/api/config?v=1" });
    expect(firstEndpointCapture([get, ...posts], [], null, null)).toBe(posts[0]);
  });
});
