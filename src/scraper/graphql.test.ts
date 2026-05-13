import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cruiseSearchCruises, GraphQlRequestError } from "@/scraper/graphql";

// Same hoisted-mock pattern as retry.test.ts — lets us assert on the
// graphql module's own logger instance without leaking into other tests.
const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({ getLogger: () => loggerStub }));

/**
 * The direct-HTTP GraphQL client is the cold path for catalog reads.
 * These tests lock its wire contract: default pagination, filter
 * passthrough, GraphQL-level errors, and upstream HTTP failures all
 * route through `GraphQlRequestError` so the service layer can fall
 * back to Stagehand deterministically.
 */

interface MockResponseInit {
  status?: number;
  body?: unknown;
}

function mockJsonResponse({ status = 200, body = {} }: MockResponseInit = {}): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {},
  };
}

type FetchLike = (input: string, init?: { body?: string }) => Promise<unknown>;

function stubFetch(): ReturnType<typeof vi.fn<FetchLike>> {
  const fn = vi.fn<FetchLike>();
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("scraper/graphql cruiseSearchCruises", () => {
  let fetchMock: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    fetchMock = stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to /cruises/graph with operationName and default variables", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        body: {
          data: {
            cruiseSearch: {
              results: { total: 0, cruises: [] },
            },
          },
        },
      })
    );
    await cruiseSearchCruises();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://www.royalcaribbean.com/cruises/graph");
    const body = JSON.parse(init?.body as string) as {
      operationName: string;
      variables: { filters: string; pagination: { count: number; skip: number } };
    };
    expect(body.operationName).toBe("cruiseSearch_Cruises");
    expect(body.variables.filters).toBe("");
    expect(body.variables.pagination).toEqual({ count: 100, skip: 0 });
  });

  it("returns the inner `results` node and preserves cruise shape", async () => {
    const cruise = {
      id: "c-1",
      productViewLink: "itinerary/x",
      masterSailing: { itinerary: { code: "WN07C111", ship: { code: "WN" } } },
      sailings: [],
    };
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        body: {
          data: {
            cruiseSearch: {
              results: { total: 42, cruises: [cruise] },
            },
          },
        },
      })
    );
    const result = await cruiseSearchCruises({
      filters: "ship:WN",
      pagination: { count: 10, skip: 20 },
    });
    expect(result.total).toBe(42);
    expect(result.cruises).toHaveLength(1);
    expect(result.cruises[0]?.id).toBe("c-1");
  });

  it("throws GraphQlRequestError on non-2xx upstream status", async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ status: 503 }));
    await expect(cruiseSearchCruises()).rejects.toBeInstanceOf(GraphQlRequestError);
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ status: 503 }));
    await expect(cruiseSearchCruises()).rejects.toMatchObject({ status: 503 });
  });

  it("throws GraphQlRequestError when the payload has a GraphQL errors array", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        body: {
          errors: [{ message: "filters invalid" }, { message: "also bad" }],
        },
      })
    );
    await expect(cruiseSearchCruises()).rejects.toMatchObject({
      name: "GraphQlRequestError",
      message: expect.stringContaining("filters invalid"),
    });
  });

  it("throws GraphQlRequestError when payload.data is missing", async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ body: { data: null } }));
    await expect(cruiseSearchCruises()).rejects.toBeInstanceOf(GraphQlRequestError);
  });

  // Pin the ops-correlation warn logs added for RC upstream failure modes.
  // A regression that drops these logs breaks ops alerting without any
  // assertion elsewhere catching it — the request still throws so the
  // higher-level tests stay green.
  it("emits a warn log on non-2xx HTTP with the status", async () => {
    loggerStub.warn.mockClear();
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ status: 503 }));
    await expect(cruiseSearchCruises()).rejects.toBeInstanceOf(GraphQlRequestError);
    expect(loggerStub.warn).toHaveBeenCalledOnce();
    expect(loggerStub.warn.mock.calls[0]?.[0]).toMatch(/HTTP 503/);
  });

  it("emits a warn log on graphql errors array with the message", async () => {
    loggerStub.warn.mockClear();
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ body: { errors: [{ message: "filters invalid" }] } })
    );
    await expect(cruiseSearchCruises()).rejects.toBeInstanceOf(GraphQlRequestError);
    expect(loggerStub.warn).toHaveBeenCalledOnce();
    expect(loggerStub.warn.mock.calls[0]?.[0]).toMatch(/filters invalid/);
  });

  it("emits a warn log when payload.data is missing", async () => {
    loggerStub.warn.mockClear();
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ body: { data: null } }));
    await expect(cruiseSearchCruises()).rejects.toBeInstanceOf(GraphQlRequestError);
    expect(loggerStub.warn).toHaveBeenCalledOnce();
    expect(loggerStub.warn.mock.calls[0]?.[0]).toMatch(/empty data/);
  });

  it("passes an AbortSignal to fetch so stalled upstreams don't hang the caller", async () => {
    // Without a timeout, a hung RC endpoint would lock the worker/cron
    // tick indefinitely. Assert the signal is provided — the actual
    // abort behavior is Node runtime machinery, not ours.
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        body: { data: { cruiseSearch: { results: { total: 0, cruises: [] } } } },
      })
    );
    await cruiseSearchCruises();
    const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps an AbortError/TimeoutError to GraphQlRequestError(504)", async () => {
    // fetch() rejects with TimeoutError (or AbortError) when the
    // AbortSignal.timeout fires. The wrapper converts that into a
    // GraphQlRequestError(504) so the service-layer catch still runs
    // the Stagehand fallback instead of leaking a raw network error.
    loggerStub.warn.mockClear();
    const timeoutErr = Object.assign(new Error("The operation timed out"), {
      name: "TimeoutError",
    });
    fetchMock.mockRejectedValueOnce(timeoutErr);
    await expect(cruiseSearchCruises()).rejects.toMatchObject({
      name: "GraphQlRequestError",
      status: 504,
    });
    expect(loggerStub.warn.mock.calls[0]?.[0]).toMatch(/timed out/);
  });

  it("lets other fetch-layer errors (e.g. DNS failure) propagate unchanged", async () => {
    // Don't want the timeout wrapper to swallow unrelated network bugs
    // — only TimeoutError/AbortError get the 504 mapping.
    const dnsErr = Object.assign(new Error("ENOTFOUND royalcaribbean.com"), {
      code: "ENOTFOUND",
    });
    fetchMock.mockRejectedValueOnce(dnsErr);
    await expect(cruiseSearchCruises()).rejects.toMatchObject({
      message: expect.stringContaining("ENOTFOUND"),
    });
  });
});
