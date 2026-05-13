import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bestPromotionForMarket,
  cruiseSearchCruises,
  GraphQlRequestError,
} from "@/scraper/graphql";

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
});

describe("scraper/graphql bestPromotionForMarket", () => {
  let fetchMock: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    fetchMock = stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to /graph with the supplied market variables", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        body: {
          data: {
            bestPromotionForMarket: {
              id: "p-1",
              code: "LOVE",
              name: "Love the Ones You Sail With",
            },
          },
        },
      })
    );
    const result = await bestPromotionForMarket({ country: "CAN", currency: "CAD" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://www.royalcaribbean.com/graph");
    const body = JSON.parse(init?.body as string) as {
      variables: { country: string; currency: string };
    };
    expect(body.variables.country).toBe("CAN");
    expect(body.variables.currency).toBe("CAD");
    expect(result?.code).toBe("LOVE");
  });

  it("returns null when the upstream has no promotion for the market", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        body: { data: { bestPromotionForMarket: null } },
      })
    );
    const result = await bestPromotionForMarket();
    expect(result).toBeNull();
  });
});
