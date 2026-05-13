import { describe, expect, it, vi } from "vitest";

import {
  expandCruiseToSailings,
  fetchSailingPackagesViaGraphql,
  pickMostSelectiveFilter,
} from "@/scraper/flows/graphql-catalog";
import type { GraphQlCruise } from "@/scraper/graphql";

/**
 * The GraphQL catalog flow is the hot path that replaces the Stagehand
 * scrape for sailing-package. These tests pin its two load-bearing
 * responsibilities: (1) `$filters` single-predicate selection honoring
 * the recon finding that multi-key AND is silently dropped, and
 * (2) client-side post-filtering on the date window + ship codes that
 * the single server-side predicate cannot express.
 */

function buildCruise(overrides: Partial<GraphQlCruise> = {}): GraphQlCruise {
  return {
    id: "cruise-1",
    productViewLink: "itinerary/western-caribbean-wn7/?sailDate=2026-06-07&packageCode=WN07C111",
    masterSailing: {
      itinerary: {
        code: "WN07C111",
        name: "7 Night Western Caribbean",
        totalNights: 7,
        sailingNights: 7,
        type: "CRUISE_ONLY",
        destination: { code: "CARIB", name: "Caribbean" },
        departurePort: { code: "MIA", name: "Miami", region: "FL" },
        ship: { code: "WN", name: "Wonder of the Seas" },
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
          {
            price: { value: 899.0, currency: { code: "USD" } },
            stateroomClass: { id: "B", content: { code: "B" } },
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

describe("scraper/flows/graphql-catalog pickMostSelectiveFilter", () => {
  it("emits a ship predicate when exactly one ship code is requested", () => {
    expect(
      pickMostSelectiveFilter({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        shipCodes: ["WN"],
      })
    ).toBe("ship:WN");
  });

  it("returns an empty filter when no ship codes are requested (paginate full catalog)", () => {
    expect(
      pickMostSelectiveFilter({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
      })
    ).toBe("");
  });

  it("returns an empty filter when multiple ship codes are requested — recon showed multi-key AND is dropped", () => {
    expect(
      pickMostSelectiveFilter({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        shipCodes: ["WN", "IC"],
      })
    ).toBe("");
  });
});

describe("scraper/flows/graphql-catalog expandCruiseToSailings", () => {
  it("flattens sailings within the date window and projects cabin pricing", () => {
    const result = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(result).toHaveLength(1);
    const first = result[0];
    expect(first?.shipCode).toBe("WN");
    expect(first?.sailDate).toBe("2026-06-07");
    expect(first?.packageCode).toBe("WN07C111");
    expect(first?.duration).toBe(7);
    expect(first?.cabinOptions).toHaveLength(2);
    expect(first?.cabinOptions?.[0]?.stateroomCategoryCode).toBe("I");
  });

  it("excludes sailings outside the request date window", () => {
    const result = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-07-01",
      toSailDate: "2026-07-31",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.sailDate).toBe("2026-07-12");
  });

  it("excludes the whole cruise when its ship is not in shipCodes", () => {
    const result = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-12-31",
      shipCodes: ["IC"],
    });
    expect(result).toEqual([]);
  });

  it("returns an empty array when itinerary metadata is missing", () => {
    const cruise = buildCruise({ masterSailing: undefined });
    const result = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(result).toEqual([]);
  });
});

describe("scraper/flows/graphql-catalog fetchSailingPackagesViaGraphql", () => {
  it("paginates until a short page is returned", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        total: 0,
        cruises: Array.from({ length: 2 }, (_, i) => buildCruise({ id: `c-${i}` })),
      })
      .mockResolvedValueOnce({
        total: 0,
        cruises: [buildCruise({ id: "c-last" })],
      });

    const result = await fetchSailingPackagesViaGraphql(
      {
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-07-31",
      },
      { fetchFn, pageSize: 2, maxPages: 5 }
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(0);
    expect(fetchFn.mock.calls[1]?.[0]).toBe(2);
    expect(result.length).toBeGreaterThan(0);
  });

  it("stops paginating when the page comes back empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ total: 0, cruises: [] });
    const result = await fetchSailingPackagesViaGraphql(
      {
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-07-31",
      },
      { fetchFn, pageSize: 50, maxPages: 10 }
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  it("dedups sailings emitted by duplicate cruises across pages", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ total: 0, cruises: [buildCruise()] })
      .mockResolvedValueOnce({ total: 0, cruises: [buildCruise()] })
      .mockResolvedValueOnce({ total: 0, cruises: [] });

    const result = await fetchSailingPackagesViaGraphql(
      {
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-07-31",
      },
      { fetchFn, pageSize: 1, maxPages: 5 }
    );
    // Two sailings on the cruise fall in window (Jun 7 + Jul 12); both
    // pages returned the same cruise, so dedup should keep exactly 2.
    expect(result).toHaveLength(2);
  });

  it("forwards the selected filter to the fetcher", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ total: 0, cruises: [] });
    await fetchSailingPackagesViaGraphql(
      {
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-07-31",
        shipCodes: ["WN"],
      },
      { fetchFn, pageSize: 50, maxPages: 1 }
    );
    expect(fetchFn).toHaveBeenCalledWith(0, 50, "ship:WN");
  });
});
