import { describe, expect, it, vi } from "vitest";

import { fetchSailingPricingViaGraphql } from "@/scraper/flows/graphql-pricing";
import type { GraphQlCruise } from "@/scraper/graphql";

/**
 * The GraphQL pricing lookup is the hot path for super-category-pricing.
 * These tests pin its two load-bearing behaviours: (1) match on the
 * `(shipCode, packageCode, sailDate)` triple, (2) pagination stops
 * promptly when the sailing is not found so we don't over-scan.
 */

function buildCruise(overrides: Partial<GraphQlCruise> = {}): GraphQlCruise {
  return {
    id: "c-1",
    masterSailing: {
      itinerary: {
        code: "WN07C111",
        ship: { code: "WN" },
      },
    },
    sailings: [
      {
        id: "s-1",
        sailDate: "2026-06-07",
        stateroomClassPricing: [
          {
            price: { value: 599.5, currency: { code: "USD" } },
            stateroomClass: { id: "I", content: { code: "I" } },
          },
        ],
      },
      {
        id: "s-2",
        sailDate: "2026-07-12",
        stateroomClassPricing: [
          {
            price: { value: 720.0, currency: { code: "USD" } },
            stateroomClass: { id: "O", content: { code: "O" } },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("scraper/flows/graphql-pricing fetchSailingPricingViaGraphql", () => {
  it("returns the matching sailing's stateroom pricing when the triple matches", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce({
      total: 1,
      cruises: [buildCruise()],
    });
    const result = await fetchSailingPricingViaGraphql(
      { shipCode: "WN", sailDate: "2026-06-07", packageCode: "WN07C111" },
      { fetchFn, pageSize: 50, maxPages: 2 }
    );
    expect(result).not.toBeNull();
    expect(result?.sailing.id).toBe("s-1");
    expect(result?.stateroomClassPricing).toHaveLength(1);
    expect(result?.stateroomClassPricing[0]?.stateroomClass.content.code).toBe("I");
  });

  it("sends a ship:XX filter to scope the scan", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ total: 0, cruises: [] });
    await fetchSailingPricingViaGraphql(
      { shipCode: "IC", sailDate: "2026-06-07", packageCode: "IC07C111" },
      { fetchFn, pageSize: 50, maxPages: 1 }
    );
    expect(fetchFn).toHaveBeenCalledWith(0, 50, "ship:IC");
  });

  it("returns null when the package code does not match anything in the page", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce({
      total: 1,
      cruises: [buildCruise()],
    });
    const result = await fetchSailingPricingViaGraphql(
      { shipCode: "WN", sailDate: "2026-06-07", packageCode: "WN07Z999" },
      { fetchFn, pageSize: 50, maxPages: 1 }
    );
    expect(result).toBeNull();
  });

  it("returns null when the package matches but no sailing has the requested sailDate", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce({
      total: 1,
      cruises: [buildCruise()],
    });
    const result = await fetchSailingPricingViaGraphql(
      { shipCode: "WN", sailDate: "2026-08-01", packageCode: "WN07C111" },
      { fetchFn, pageSize: 50, maxPages: 1 }
    );
    expect(result).toBeNull();
  });

  it("stops paginating after the first short page", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ total: 0, cruises: [] });
    await fetchSailingPricingViaGraphql(
      { shipCode: "WN", sailDate: "2026-06-07", packageCode: "WN07C111" },
      { fetchFn, pageSize: 50, maxPages: 6 }
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // With no options.fetchFn, the flow routes through cruiseSearchCruises
  // against RC's live GraphQL endpoint. Stubbing global fetch to return
  // a canned response lets us verify the default-fetch wrapper wires up
  // correctly — without it, production calls would silently no-op.
  it("uses cruiseSearchCruises when no fetchFn is provided (default-fetch integration)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {},
      json: async () => ({
        data: {
          cruiseSearch: {
            results: { total: 1, cruises: [buildCruise()] },
          },
        },
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await fetchSailingPricingViaGraphql(
        { shipCode: "WN", sailDate: "2026-06-07", packageCode: "WN07C111" },
        { pageSize: 1, maxPages: 1 }
      );
      expect(result).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe("https://www.royalcaribbean.com/cruises/graph");
      const body = JSON.parse(init?.body as string) as {
        variables: { filters: string };
      };
      expect(body.variables.filters).toBe("ship:WN");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
