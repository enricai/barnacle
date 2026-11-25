import { describe, expect, it } from "vitest";
import {
  firstEndpointCapture,
  truncateActionSequenceAtSubmitPattern,
} from "@/scripts/recon-generate";
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
    const post = cap({
      method: "POST",
      url: "https://example.com/api/submit",
      requestPostData: "{}",
    });
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

describe("truncateActionSequenceAtSubmitPattern preflights", () => {
  it("never matches or retains OPTIONS captures", () => {
    const url = "https://example.com/api/search";
    const seq = [
      { capture: cap({ method: "OPTIONS", url }), index: 0 },
      { capture: cap({ method: "POST", url }), index: 1 },
      { capture: cap({ method: "OPTIONS", url }), index: 2 },
      { capture: cap({ method: "POST", url }), index: 3 },
      { capture: cap({ method: "OPTIONS", url }), index: 4 },
    ];
    const out = truncateActionSequenceAtSubmitPattern(seq, { endpoint: "/api/search", body: null });
    expect(out.map((s) => s.index)).toEqual([1, 3]);
    expect(
      truncateActionSequenceAtSubmitPattern([seq[0]!], { endpoint: "/api/search", body: null })
    ).toEqual([]);
  });
});

describe("truncateActionSequenceAtSubmitPattern pre-submit beacons", () => {
  const pats = { endpoint: "/api/search$", body: null };
  const post = (path: string, body: unknown, response: unknown, index: number) => ({
    capture: cap({
      method: "POST",
      url: `https://example.com${path}`,
      requestPostData: JSON.stringify(body),
      responseBody: response,
    }),
    index,
  });

  const save = (n: number) => post("/api/section", { section: n }, { saved: true }, n);
  const search = (q: string, i: number) =>
    post("/api/search", { q }, { hits: [{ id: `hit-${q}` }] }, i);
  const indices = (
    seq: Parameters<typeof truncateActionSequenceAtSubmitPattern>[0],
    submitStep = false
  ) => truncateActionSequenceAtSubmitPattern(seq, pats, null, submitStep).map((s) => s.index);

  it("keeps every wizard save that answers a constant acknowledgement", () => {
    expect(
      indices([save(0), save(1), save(2), post("/api/search", { q: "a" }, { id: 9 }, 3)])
    ).toEqual([0, 1, 2, 3]);
  });

  it("keeps saves when the declared endpoint is itself a re-posted write", () => {
    const write = (n: number) => post("/api/search", { n }, { saved: true }, n);
    expect(indices([save(0), write(1), write(2)])).toEqual([0, 1, 2]);
  });

  it("drops telemetry between re-queried searches but keeps a hop a later request uses", () => {
    const token = post("/api/session", {}, { token: "tok-12345" }, 0);
    const uses = post("/api/search", { q: "b", t: "tok-12345" }, { hits: [{ id: "hit-b" }] }, 3);
    const seq = [token, search("a", 1), post("/api/ui-events", { e: 1 }, { ok: true }, 2), uses];
    expect(indices(seq)).toEqual([0, 1, 3]);
    expect(indices(seq, true)).toEqual([0, 1, 2, 3]);
  });

  it("keeps a session hop whose cookie, header or encoded token a later search sends", () => {
    const hop = (responseHeaders: Record<string, string>, body: unknown = { ok: true }) => ({
      capture: cap({
        method: "POST",
        url: "https://example.com/api/session",
        requestPostData: "{}",
        responseHeaders,
        responseBody: body,
      }),
      index: 0,
    });
    const sends = (
      requestHeaders: Record<string, string>,
      requestPostData = JSON.stringify({ q: "a" })
    ) => ({
      capture: cap({
        method: "POST",
        url: "https://example.com/api/search",
        requestPostData,
        requestHeaders,
        responseBody: { hits: [{ id: "hit-a" }] },
      }),
      index: 1,
    });
    const kept = [
      [hop({ "set-cookie": "sid=abcdef123; Path=/" }), sends({ cookie: "sid=abcdef123" })],
      [hop({ "x-csrf-token": "csrf-9999" }), sends({ "x-csrf-token": "csrf-9999" })],
      [hop({}, { token: "ab+/cd==" }), sends({ "x-session": "ab%2B%2Fcd%3D%3D" })],
    ];
    for (const pair of kept) {
      expect(indices([...pair, search("b", 2)])).toEqual([0, 1, 2]);
    }
    expect(indices([hop({ "cache-control": "no-cache" }), sends({}), search("b", 2)])).toEqual([
      1, 2,
    ]);
  });

  it("keeps two differing pre-submit requests that share an acknowledgement", () => {
    const seq = [
      post("/api/quote", { filters: ["A"] }, { ok: true }, 0),
      post("/api/quote", { filters: ["A", "B"] }, { ok: true }, 1),
      post("/api/search", { q: "a" }, { hits: [1] }, 2),
    ];
    expect(truncateActionSequenceAtSubmitPattern(seq, pats).map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("keeps a pre-submit endpoint whose answers depend on the request", () => {
    const seq = [0, 1, 2].map((n) => post("/api/step", { n }, { echo: n }, n));
    seq.push(post("/api/search", { q: "a" }, { hits: [1] }, 3));
    expect(truncateActionSequenceAtSubmitPattern(seq, pats).map((s) => s.index)).toEqual([
      0, 1, 2, 3,
    ]);
  });
});
