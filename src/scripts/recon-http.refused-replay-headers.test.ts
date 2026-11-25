/** A refused replay is re-sent with the captured app headers; a declared read-only POST is replayed. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));

import { deriveRequestHeaders, shapeRestoringCredentialHeaders } from "@/scripts/recon-generate";
import { replayCapture, selectRateLimitTargets, selectReplayCaptures } from "@/scripts/recon-http";
import {
  type Capture,
  type ReplayResult,
  readDeclaredReadMatcher,
  replayPassed,
  replayReachable,
} from "@/scripts/recon-shared";

const SEARCH = "https://api.example.test/pricing/v1/trips";

function cap(o: Partial<Capture> = {}): Capture {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "GET",
    url: SEARCH,
    status: 200,
    requestHeaders: {
      ":authority": "api.example.test",
      host: "api.example.test",
      Cookie: "sid=1",
      Authorization: "Basic zzz",
      "X-App-Id": "web",
      "X-Brand": "north",
      "X-Noise": "1",
    },
    requestPostData: null,
    responseHeaders: {},
    responseBody: { trips: [{ id: 1 }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
    ...o,
  };
}

/** Answers `status` until every header in `required` is sent. */
function server(required: string[], status = 403, okBody: unknown = { trips: [{ id: 2 }] }) {
  const seen: Array<Record<string, string>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seen.push(headers);
      const ok = required.every((h) => headers[h] !== undefined);
      return new Response(JSON.stringify(ok ? okBody : { error: "denied" }), {
        status: ok ? 200 : status,
        headers: { "content-type": "application/json" },
      });
    })
  );
  return seen;
}

const replay = async (capture: Capture, opts = {}): Promise<ReplayResult> => {
  const result = await replayCapture("a.json", capture, opts);
  if (result === null) throw new Error("capture was skipped");
  return result;
};

const dirs: string[] = [];
function flowFile(flow: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "declared-read-"));
  dirs.push(dir);
  const file = join(dir, "flow.json");
  writeFileSync(file, JSON.stringify(flow));
  return file;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recon-http refused replay", () => {
  it.each([400, 401, 403])(
    "on %i finds the minimal captured header set that lifts it",
    async (status) => {
      server(["X-App-Id", "X-Brand"], status);
      const r = await replay(cap());
      expect(r.replayStatus).toBe(status);
      expect(r.headerReplay).toEqual({ status: 200 });
      expect(r.shapeRestoringHeaders).toEqual(["X-App-Id", "X-Brand"]);
      expect(replayReachable(r)).toBe(true);
      expect(replayPassed(r)).toBe(false);
    }
  );

  it("never re-sends cookies, credentials or transport headers", async () => {
    const seen = server(["X-App-Id"]);
    await replay(cap());
    expect(seen.length).toBeGreaterThan(1);
    for (const headers of seen) {
      for (const name of ["Cookie", "Authorization", "host", ":authority"]) {
        expect(headers).not.toHaveProperty([name]);
      }
    }
  });

  it("costs one extra request when the headers do not lift it", async () => {
    const seen = server(["X-Other"]);
    const r = await replay(cap());
    expect(seen).toHaveLength(2);
    expect(r.headerReplay).toBeUndefined();
    expect(r.shapeRestoringHeaders).toEqual([]);
    expect(replayReachable(r)).toBe(false);
  });

  it("does not count a 2xx that is not the captured response", async () => {
    const seen = server(["X-App-Id"], 403, { login: "required" });
    const r = await replay(cap());
    expect(seen).toHaveLength(2);
    expect(replayReachable(r)).toBe(false);
  });

  it("sends nothing more on another status, without app headers, or for an unsafe method", async () => {
    for (const [capture, status] of [
      [cap(), 404],
      [cap(), 500],
      [cap({ requestHeaders: { Cookie: "sid=1" } }), 403],
      [cap({ method: "POST", requestPostData: "{}" }), 403],
    ] as const) {
      const seen = server(["X-App-Id"], status);
      await replay(capture);
      expect(seen, `${capture.method} ${status}`).toHaveLength(1);
    }
  });

  it("leaves a 401 the bearer re-replay already lifts to that re-replay", async () => {
    const seen = server(["Authorization"], 401);
    const r = await replay(cap());
    expect(seen).toHaveLength(2);
    expect(r.authReplay?.tokenReplayable).toBe(true);
    expect(r.headerReplay).toBeUndefined();
  });

  it("rate-probes the endpoint with the lifting headers and emits them as base headers", async () => {
    server(["X-App-Id", "X-Session-Token"]);
    const capture = cap({ requestHeaders: { "X-App-Id": "web", "X-Session-Token": "s3cret" } });
    const r = await replay(capture);
    const { targets } = selectRateLimitTargets(
      [r],
      ["api.example.test"],
      null,
      [],
      undefined,
      () => capture.requestHeaders
    );
    expect(targets.get(SEARCH)?.headers).toEqual(capture.requestHeaders);
    const other = cap({ requestHeaders: {} });
    const emitted = deriveRequestHeaders([capture, other], [r], "https://api.example.test");
    expect(emitted).toMatchObject({ "X-App-Id": "web" });
    expect(JSON.stringify(emitted)).not.toContain("s3cret");
    expect(shapeRestoringCredentialHeaders([r])).toEqual(["X-Session-Token"]);
  });
});

describe("recon-http declared read-only POST", () => {
  const post = (o: Partial<Capture> = {}) =>
    cap({ method: "POST", requestPostData: '{"filters":{"region":"east"}}', ...o });
  const FLOW = { readOnly: true, submitEndpointPattern: "pricing/v1/trips$", steps: [] };
  const select = (flow: unknown, capture: Capture) =>
    selectReplayCaptures(
      [{ filename: "a.json", capture }],
      false,
      null,
      readDeclaredReadMatcher(flowFile(flow))
    ).selected.length;

  it("is replayed only when the flow is readOnly and the request matches its pattern", () => {
    expect(select(FLOW, post())).toBe(1);
    expect(select({ ...FLOW, readOnly: false }, post())).toBe(0);
    expect(select({ ...FLOW, readOnly: undefined }, post())).toBe(0);
    expect(select({ ...FLOW, submitEndpointPattern: undefined }, post())).toBe(0);
    expect(select({ ...FLOW, submitEndpointPattern: "(" }, post())).toBe(0);
    expect(select(FLOW, post({ url: "https://api.example.test/orders" }))).toBe(0);
    expect(select(FLOW, post({ method: "DELETE" }))).toBe(0);
    expect(select([], post())).toBe(0);
  });

  it("must also match the declared body pattern", () => {
    expect(select({ ...FLOW, submitBodyPattern: "filters" }, post())).toBe(1);
    expect(select({ ...FLOW, submitBodyPattern: "placeOrder" }, post())).toBe(0);
  });

  it("never covers a GraphQL mutation", () => {
    const mutation = post({ query: "mutation { book { id } }", operationName: "book" });
    expect(select(FLOW, mutation)).toBe(0);
  });

  it("is header-retried and rate-probed like any safe request", async () => {
    const isDeclaredRead = readDeclaredReadMatcher(flowFile(FLOW));
    server(["X-App-Id"]);
    const capture = post();
    const r = await replay(capture, { isDeclaredRead });
    expect(r.shapeRestoringHeaders).toEqual(["X-App-Id"]);
    const probe = (matcher: typeof isDeclaredRead) =>
      selectRateLimitTargets(
        [r],
        ["api.example.test"],
        null,
        [],
        undefined,
        () => capture.requestHeaders,
        matcher
      ).targets.get(SEARCH);
    expect(probe(isDeclaredRead)).toMatchObject({
      method: "POST",
      body: capture.requestPostData,
      headers: { "X-App-Id": "web" },
    });
    expect(probe(null)).toBeUndefined();
  });
});
