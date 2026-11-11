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
vi.mock("@/lib/logging", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));

import {
  deriveRequestHeaders,
  emitContractTs,
  shapeRestoringCredentialHeaders,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import { replayCapture } from "@/scripts/recon-http";

const ORIGIN = "https://api.example.com";
const URL_DIVERGING = `${ORIGIN}/v1/items.json`;
const URL_OTHER = `${ORIGIN}/v1/other.json`;
const CAMEL = { itemCount: 1, displayName: "a" };
const SNAKE = { item_count: 1, display_name: "a" };

/** The captured request headers of the diverging endpoint. */
const BROWSER_HEADERS = {
  "Content-Type": "application/json",
  "Key-Inflection": "camel",
  "X-Requested-With": "XMLHttpRequest",
  "Accept-Language": "fr-FR",
  Authorization: "Bearer recon-session-token",
  Cookie: "sid=recon-session",
  "If-None-Match": 'W/"etag-1"',
};

const diverging = buildCapture({
  url: URL_DIVERGING,
  method: "GET",
  requestPostData: null,
  responseBody: CAMEL,
  requestHeaders: BROWSER_HEADERS,
  timestamp: "2026-08-01T00:00:00Z",
});
// A second endpoint that replays fine and carries none of the diverging
// endpoint's headers, so only re-replay proof can put one in BASE_HEADERS.
const other = buildCapture({
  url: URL_OTHER,
  method: "GET",
  requestPostData: null,
  responseBody: { ok: true },
  requestHeaders: { "Content-Type": "application/json" },
  timestamp: "2026-08-01T00:00:01Z",
});

type Respond = (sent: Headers) => { status?: number; body: string; type?: string };

function stubServer(respond: Respond) {
  const f = vi.fn(async (_u: unknown, init?: { headers?: Record<string, string> }) => {
    const r = respond(new Headers(init?.headers ?? {}));
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: { "content-type": r.type ?? "application/json" },
    });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

async function replayAndDerive() {
  const r = await replayCapture("a.json", diverging as never);
  const otherReplay = {
    sourceCapture: "b.json",
    url: URL_OTHER,
    method: "GET",
    operationName: null,
    requestBody: null,
    replayStatus: 200,
    replayHeaders: {},
    replayBody: { ok: true },
    success: true,
    error: null,
    shapeDiffers: false,
  };
  const replays = [r!, otherReplay];
  return { r: r!, replays, base: deriveRequestHeaders([diverging, other], replays, ORIGIN) };
}

const lower = (h: Record<string, string>) => Object.keys(h).map((k) => k.toLowerCase());

describe("a shape-diverging replay adds only the headers re-replay proves restore its shape", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("freezes nothing when a 200 login page comes back whatever is re-sent", async () => {
    const f = stubServer(() => ({ body: "<html>sign in</html>", type: "text/html" }));
    const { r, replays, base } = await replayAndDerive();
    expect(r.shapeDiffers).toBe(true);
    expect(r.shapeRestoringHeaders).toEqual([]);
    expect(f.mock.calls.length).toBeGreaterThan(1);
    for (const h of Object.keys(BROWSER_HEADERS).filter((h) => h !== "Content-Type")) {
      expect(lower(base)).not.toContain(h.toLowerCase());
    }
    expect(shapeRestoringCredentialHeaders(replays)).toEqual([]);
    expect(r.error).toContain("no omitted header restores it when re-sent");
  });

  it("adds exactly the content-negotiation header that restores the reported casing", async () => {
    stubServer((sent) => ({
      body: JSON.stringify(sent.get("key-inflection") === "camel" ? CAMEL : SNAKE),
    }));
    const { r, base } = await replayAndDerive();
    expect(r.shapeRestoringHeaders).toEqual(["Key-Inflection"]);
    expect(base["Key-Inflection"]).toBe("camel");
    for (const h of [
      "x-requested-with",
      "accept-language",
      "authorization",
      "cookie",
      "if-none-match",
    ])
      expect(lower(base)).not.toContain(h);
    expect(r.error).toContain("restored by re-sending: Key-Inflection");
  });

  it("of two candidates that both differ from the replay, adds only the one that matters", async () => {
    stubServer((sent) => ({
      body: JSON.stringify(sent.get("accept-language") === "fr-FR" ? CAMEL : SNAKE),
    }));
    const { r, base } = await replayAndDerive();
    expect(r.shapeRestoringHeaders).toEqual(["Accept-Language"]);
    expect(base["Accept-Language"]).toBe("fr-FR");
    expect(lower(base)).not.toContain("key-inflection");
    expect(lower(base)).not.toContain("x-requested-with");
  });

  it("finds a minimal set when only two headers together restore the shape", async () => {
    stubServer((sent) => ({
      body: JSON.stringify(
        sent.get("key-inflection") === "camel" && sent.get("x-requested-with") ? CAMEL : SNAKE
      ),
    }));
    const { r, base } = await replayAndDerive();
    expect(r.shapeRestoringHeaders).toEqual(["Key-Inflection", "X-Requested-With"]);
    expect(base["Key-Inflection"]).toBe("camel");
    expect(base["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(lower(base)).not.toContain("accept-language");
  });

  it("never freezes a credential, even one proven to restore the shape: it surfaces as a TODO", async () => {
    stubServer((sent) => ({
      body: JSON.stringify(sent.get("authorization") ? CAMEL : SNAKE),
    }));
    const { r, replays, base } = await replayAndDerive();
    expect(r.shapeRestoringHeaders).toEqual(["Authorization"]);
    expect(lower(base)).not.toContain("authorization");
    expect(JSON.stringify(base)).not.toContain("recon-session-token");
    expect(shapeRestoringCredentialHeaders(replays)).toEqual(["Authorization"]);
    const contract = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: ORIGIN,
      baseHeaders: base,
      credentialHeadersToObtain: shapeRestoringCredentialHeaders(replays),
      minTime: 100,
      safeRps: 10,
      responseBody: CAMEL,
      gql: false,
      gqlQuery: null,
      endpointPath: "/v1/items.json",
      auxFiles: [],
    });
    expect(contract).toContain("// TODO: recon:http proved Authorization restores");
    expect(contract).not.toContain("recon-session-token");
  });
});

describe("re-replay credits a header only with a divergence it reproduces", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("credits no header when an unchanged re-send already matches the capture", async () => {
    let calls = 0;
    stubServer(() => ({ body: JSON.stringify(calls++ === 0 ? SNAKE : CAMEL) }));
    const { r, base } = await replayAndDerive();
    expect(r.shapeDiffers).toBe(true);
    expect(r.shapeRestoringHeaders).toEqual([]);
    for (const h of ["key-inflection", "x-requested-with", "accept-language"])
      expect(lower(base)).not.toContain(h);
    expect(r.error).toContain("the divergence did not reproduce on an unchanged re-send");
  });

  it.each([
    [
      "an envelope's list comes back empty",
      { data: [{ itemCount: 1 }] },
      { data: [{ item_count: 1 }] },
      '{"data":[]}',
    ],
    ["a top-level list comes back empty", [{ itemCount: 1 }], [{ item_count: 1 }], "[]"],
    ["a JSON null comes back", { itemCount: 1 }, { item_count: 1 }, "null"],
    [
      "an empty object comes back in an envelope",
      { data: { itemCount: 1 } },
      { data: { item_count: 1 } },
      '{"data":{}}',
    ],
  ])(
    "credits no header when re-sending it only empties the answer: %s",
    async (_n, captured, without, withHeader) => {
      const c = buildCapture({
        url: URL_DIVERGING,
        method: "GET",
        requestPostData: null,
        responseBody: captured,
        requestHeaders: { "X-Region": "eu", "Key-Inflection": "camel" },
        timestamp: "2026-08-01T00:00:00Z",
      });
      stubServer((sent) => ({ body: sent.get("x-region") ? withHeader : JSON.stringify(without) }));
      const r = await replayCapture("a.json", c as never);
      expect(r?.shapeDiffers).toBe(true);
      expect(r?.shapeRestoringHeaders).toEqual([]);
    }
  );

  it("credits no header whose re-send returns a body that cannot be read", async () => {
    const c = buildCapture({
      url: URL_DIVERGING,
      method: "GET",
      requestPostData: null,
      responseBody: CAMEL,
      requestHeaders: { "X-Region": "eu" },
      timestamp: "2026-08-01T00:00:00Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: { headers?: Record<string, string> }) => {
        if (!new Headers(init?.headers ?? {}).get("x-region"))
          return new Response(JSON.stringify(SNAKE), { status: 200 });
        const broken = new ReadableStream({
          start(controller) {
            controller.error(new Error("stream reset"));
          },
        });
        return new Response(broken, { status: 200 });
      })
    );
    const r = await replayCapture("a.json", c as never);
    expect(r?.shapeRestoringHeaders).toEqual([]);
  });

  it("re-sends one spelling per header and never a transport header", async () => {
    const h2 = buildCapture({
      url: URL_DIVERGING,
      method: "GET",
      requestPostData: null,
      responseBody: CAMEL,
      requestHeaders: {
        "X-A": "1",
        "x-a": "1",
        "X-B": "2",
        "x-b": "2",
        "content-length": "999",
        ":authority": "api.example.com",
      },
      timestamp: "2026-08-01T00:00:00Z",
    });
    const f = stubServer((sent) => ({
      body: JSON.stringify(sent.get("x-a") === "1" && sent.get("x-b") === "2" ? CAMEL : SNAKE),
    }));
    const r = await replayCapture("a.json", h2 as never);
    expect(r?.shapeRestoringHeaders).toEqual(["X-A", "X-B"]);
    for (const [, init] of f.mock.calls) {
      const sent = new Headers((init as { headers?: Record<string, string> }).headers ?? {});
      expect(sent.has("content-length")).toBe(false);
      expect(sent.get("x-a") ?? "1").toBe("1");
    }
  });
});

describe("deriveRequestHeaders never freezes a credential present on every capture", () => {
  it("drops Authorization and If-None-Match from the all-captures baseline", () => {
    const only = buildCapture({
      url: URL_OTHER,
      method: "GET",
      requestPostData: null,
      responseBody: { ok: true },
      requestHeaders: {
        "Content-Type": "application/json",
        Authorization: "Bearer recon-session-token",
        "If-None-Match": 'W/"etag-1"',
        "X-Api-Version": "3",
      },
      timestamp: "2026-08-01T00:00:00Z",
    });
    const replays = [
      {
        sourceCapture: "a.json",
        url: URL_OTHER,
        method: "GET",
        operationName: null,
        requestBody: null,
        replayStatus: 200,
        replayHeaders: {},
        replayBody: { ok: true },
        success: true,
        error: null,
      },
    ];
    const base = deriveRequestHeaders([only], replays, ORIGIN);
    expect(base["X-Api-Version"]).toBe("3");
    expect(lower(base)).not.toContain("authorization");
    expect(lower(base)).not.toContain("if-none-match");
  });
});
