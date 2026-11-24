import { describe, expect, it } from "vitest";

import { type ReplayResult, selectRateLimitTargets } from "./recon-http";

function replay(url: string, over: Partial<ReplayResult> = {}): ReplayResult {
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
    ...over,
  };
}

const authed = (url: string, over: Partial<ReplayResult> = {}) =>
  replay(url, {
    replayStatus: 401,
    success: false,
    authReplay: { status: 200, tokenReplayable: true, tokenSource: null },
    ...over,
  });

describe("selectRateLimitTargets — declared submit endpoint via replayed auth", () => {
  const caps = () => ({ authorization: "Bearer t" });
  it("lists the auth-replayed declared endpoint first, carrying authorization", () => {
    const { targets } = selectRateLimitTargets(
      [replay("https://example.com/api/a"), authed("https://example.com/api/submit")],
      ["example.com"],
      null,
      ["/api/submit"],
      "/api/submit",
      caps
    );
    expect(Array.from(targets.keys())[0]).toBe("https://example.com/api/submit");
    expect(targets.get("https://example.com/api/submit")?.headers).toEqual({
      authorization: "Bearer t",
    });
  });
  it("never probes unsafe mutations even with auth", () => {
    const { targets } = selectRateLimitTargets(
      [authed("https://example.com/api/submit", { method: "POST", requestBody: '{"a":1}' })],
      ["example.com"],
      null,
      ["/api/submit"],
      "/api/submit",
      caps
    );
    expect(targets.size).toBe(0);
  });
  it("still skips 401s whose auth retry failed", () => {
    const r = authed("https://example.com/api/x", {
      authReplay: { status: 401, tokenReplayable: false, tokenSource: null },
    });
    expect(selectRateLimitTargets([r], ["example.com"]).targets.size).toBe(0);
  });
});

describe("selectRateLimitTargets — declared body on a multiplexed endpoint", () => {
  const url = "https://api.example.com/graphql";
  const chrome = () => replay(url, { method: "POST", requestBody: '{"query":"query Chrome { a }"}' });
  const declared = () =>
    replay(url, {
      method: "POST",
      requestBody: '{"query":"query Search { b }"}',
      sourceCapture: "001-capture.json",
      replayStatus: 401,
      success: false,
      authReplay: { status: 200, tokenReplayable: true, tokenSource: null },
    });
  const caps = (r: ReplayResult) =>
    r.sourceCapture === "001-capture.json" ? { authorization: "Bearer t" } : undefined;

  it("picks the replay matching the body pattern over capture order", () => {
    const { targets } = selectRateLimitTargets(
      [chrome(), declared()],
      ["example.com"],
      null,
      ["/graphql"],
      "/graphql",
      caps,
      "Search"
    );
    expect([...targets.values()]).toEqual([
      { method: "POST", body: '{"query":"query Search { b }"}', headers: { authorization: "Bearer t" } },
    ]);
  });

  it("keeps first-replay selection without a body pattern", () => {
    const { targets } = selectRateLimitTargets(
      [chrome(), declared()],
      ["example.com"],
      null,
      ["/graphql"],
      "/graphql",
      caps
    );
    expect([...targets.values()][0]?.body).toBe('{"query":"query Chrome { a }"}');
  });
});
