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

  it("falls through to a single departurePort when no ship is given", () => {
    expect(
      pickMostSelectiveFilter({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        departurePorts: ["MIA"],
      })
    ).toBe("departurePort:MIA");
  });

  it("falls through to a single destination when no ship or port is given", () => {
    expect(
      pickMostSelectiveFilter({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        destinations: ["CARIB"],
      })
    ).toBe("destination:CARIB");
  });

  it("falls through to cruiseLength only when min === max (single-valued predicate)", () => {
    expect(
      pickMostSelectiveFilter({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        cruiseLengthRange: { min: 7, max: 7 },
      })
    ).toBe("cruiseLength:7");
  });

  it("returns empty filter when cruiseLengthRange is a true range (handled client-side)", () => {
    expect(
      pickMostSelectiveFilter({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        cruiseLengthRange: { min: 5, max: 9 },
      })
    ).toBe("");
  });

  it("prefers ship over departurePort over destination over cruiseLength", () => {
    // All four are "single-valued"; ship must win.
    expect(
      pickMostSelectiveFilter({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        shipCodes: ["WN"],
        departurePorts: ["MIA"],
        destinations: ["CARIB"],
        cruiseLengthRange: { min: 7, max: 7 },
      })
    ).toBe("ship:WN");
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

  it("excludes the whole cruise when its destination is not in destinations", () => {
    const result = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-12-31",
      destinations: ["BAHAM"],
    });
    expect(result).toEqual([]);
  });

  it("keeps the cruise when its destination matches one of the requested destinations", () => {
    const result = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-12-31",
      destinations: ["BAHAM", "CARIB"],
    });
    expect(result.length).toBeGreaterThan(0);
  });

  it("excludes the whole cruise when its departurePort is not in departurePorts", () => {
    const result = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-12-31",
      departurePorts: ["FLL"],
    });
    expect(result).toEqual([]);
  });

  it("excludes cruises outside the cruiseLengthRange window", () => {
    // buildCruise default: 7 nights. A 3..5 window drops the whole cruise.
    const result = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-12-31",
      cruiseLengthRange: { min: 3, max: 5 },
    });
    expect(result).toEqual([]);
  });

  it("keeps cruises at the cruiseLengthRange boundaries (inclusive)", () => {
    const result = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-12-31",
      cruiseLengthRange: { min: 7, max: 7 },
    });
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters sailings to those offering the requested cabinType", () => {
    // buildCruise default: s-1 has I+B classes, s-2 has only O. cabinType=BALCONY
    // should keep s-1 and drop s-2; cabinType=OUTSIDE should keep s-2 and drop s-1.
    const withBalcony = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-12-31",
      cabinType: "BALCONY",
    });
    expect(withBalcony.map((s) => s.sailDate)).toEqual(["2026-06-07"]);

    const withOutside = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-12-31",
      cabinType: "OUTSIDE",
    });
    expect(withOutside.map((s) => s.sailDate)).toEqual(["2026-07-12"]);
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

  it("normalizes a relative productViewLink into a royalcaribbean.com URL", () => {
    const cruise = buildCruise({
      productViewLink: "itinerary/wn7/?sailDate=2026-06-07&packageCode=WN07C111",
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.bookingUrl).toBe(
      "https://www.royalcaribbean.com/itinerary/wn7/?sailDate=2026-06-07&packageCode=WN07C111"
    );
  });

  it("passes through an already-absolute productViewLink unchanged", () => {
    const cruise = buildCruise({
      productViewLink: "https://www.royalcaribbean.co.uk/itinerary/wn7",
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.bookingUrl).toBe("https://www.royalcaribbean.co.uk/itinerary/wn7");
  });

  it("flattens itinerary days into VPS schedule entries (one per day×port)", () => {
    // Exercises the mapItineraryDays helper end-to-end. RC's wire shape
    // is days[].ports[]; VPS wants a flat schedule[] with dayNumber
    // repeated for multi-port days.
    const cruise = buildCruise({
      masterSailing: {
        itinerary: {
          code: "WN04B001",
          name: "4 Night Bahamas",
          totalNights: 4,
          ship: { code: "WN", name: "Wonder" },
          days: [
            {
              number: 1,
              ports: [
                {
                  activity: "EMBARK",
                  arrivalTime: null,
                  departureTime: "16:30:00",
                  port: {
                    code: "MIA",
                    name: "Miami",
                    region: "Florida",
                    countryCode: "USA",
                  },
                },
              ],
            },
            {
              number: 2,
              ports: [
                {
                  activity: "DOCKED",
                  arrivalTime: "07:00:00",
                  departureTime: "17:00:00",
                  port: {
                    code: "PCC",
                    name: "CocoCay",
                    region: "Bahamas",
                    countryCode: "BHS",
                  },
                },
              ],
            },
            {
              number: 3,
              ports: [
                {
                  activity: "CRUISING",
                  arrivalTime: null,
                  departureTime: null,
                  port: { code: "CRU", name: "Cruising", region: null, countryCode: null },
                },
              ],
            },
          ],
        },
      },
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.sailingItinerary?.itineraryCode).toBe("WN04B001");
    expect(sailing?.sailingItinerary?.duration).toBe(4);
    expect(sailing?.sailingItinerary?.schedule).toHaveLength(3);
    const day1 = sailing?.sailingItinerary?.schedule[0];
    expect(day1?.dayNumber).toBe(1);
    expect(day1?.portCode).toBe("MIA");
    expect(day1?.activity).toBe("EMBARK");
    expect(day1?.departureTime).toBe("16:30:00");
    expect(day1?.arrivalTime).toBeUndefined();
    // countryCode comes from Port.countryCode (ISO-3). VPS fixtures
    // populate `countryName` ("UNITED STATES") which RC's GraphQL
    // doesn't expose, so we leave countryName undefined and let
    // clients map code → label themselves.
    expect(day1?.countryCode).toBe("USA");
    expect(day1?.region).toBe("Florida");
    expect(day1?.countryName).toBeUndefined();
    // Null countryCode + null region (CRU cruising day) both collapse
    // to undefined — regression guard against accidental String(null).
    const day3 = sailing?.sailingItinerary?.schedule[2];
    expect(day3?.countryCode).toBeUndefined();
    expect(day3?.region).toBeUndefined();
  });

  it("emits one schedule entry per port on multi-port days", () => {
    const cruise = buildCruise({
      masterSailing: {
        itinerary: {
          code: "X",
          totalNights: 1,
          ship: { code: "WN" },
          days: [
            {
              number: 1,
              ports: [
                { activity: "DOCKED", port: { code: "A" } },
                { activity: "DOCKED", port: { code: "B" } },
              ],
            },
          ],
        },
      },
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.sailingItinerary?.schedule).toHaveLength(2);
    expect(sailing?.sailingItinerary?.schedule[0]?.dayNumber).toBe(1);
    expect(sailing?.sailingItinerary?.schedule[1]?.dayNumber).toBe(1);
    expect(sailing?.sailingItinerary?.schedule[0]?.portCode).toBe("A");
    expect(sailing?.sailingItinerary?.schedule[1]?.portCode).toBe("B");
  });

  it("emits a dayNumber-only entry when a day has no ports (at-sea placeholder)", () => {
    const cruise = buildCruise({
      masterSailing: {
        itinerary: {
          code: "X",
          totalNights: 2,
          ship: { code: "WN" },
          days: [
            { number: 1, ports: [{ activity: "EMBARK", port: { code: "MIA" } }] },
            { number: 2, ports: [] },
          ],
        },
      },
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.sailingItinerary?.schedule).toHaveLength(2);
    const day2 = sailing?.sailingItinerary?.schedule[1];
    expect(day2?.dayNumber).toBe(2);
    expect(day2?.portCode).toBeUndefined();
    expect(day2?.activity).toBeUndefined();
  });

  it("omits sailingItinerary when days is absent (Stagehand fallback path)", () => {
    const cruise = buildCruise({
      masterSailing: {
        itinerary: {
          code: "X",
          totalNights: 7,
          ship: { code: "WN" },
          // days intentionally missing
        },
      },
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.sailingItinerary).toBeUndefined();
  });

  it("omits bookingUrl when productViewLink is absent", () => {
    const cruise = buildCruise({ productViewLink: undefined });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.bookingUrl).toBeUndefined();
  });

  it("maps preTour and postTour into VPS tours[] with derived schedule dates", () => {
    // Tour date derivation matches the VPS fixture convention:
    //   PRE:  day 1 = sailDate - tourDuration (ends day before embark)
    //   POST: day 1 = sailDate + cruiseDuration (starts day of debark)
    const cruise = buildCruise({
      sailings: [
        {
          id: "s-1",
          sailDate: "2025-06-20",
          stateroomClassPricing: [],
        },
      ],
      masterSailing: {
        itinerary: {
          code: "AN07",
          totalNights: 7,
          ship: { code: "AN" },
          days: [{ number: 1, ports: [{ activity: "EMBARK", port: { code: "SEW" } }] }],
          preTour: {
            code: "A5R09B",
            duration: 3,
            days: [
              { number: 1, ports: [{ activity: "LAND", port: { code: "ANC" } }] },
              { number: 2, ports: [{ activity: "LAND", port: { code: "DEN" } }] },
              { number: 3, ports: [{ activity: "LAND", port: { code: "DEN" } }] },
            ],
          },
          postTour: {
            code: "A7R05A",
            duration: 5,
            days: [{ number: 1, ports: [{ activity: "LAND", port: { code: "SEW" } }] }],
          },
        },
      },
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
    });
    expect(sailing?.tours).toHaveLength(2);
    expect(sailing?.tours?.[0]?.tourCode).toBe("A5R09B");
    expect(sailing?.tours?.[0]?.tourTypeCode).toBe("PRE");
    expect(sailing?.tours?.[0]?.duration).toBe(3);
    expect(sailing?.tours?.[0]?.schedule?.[0]?.portCode).toBe("ANC");
    // Pre-tour: sailDate 2025-06-20, duration 3 → day 1 = 2025-06-17
    expect(sailing?.tours?.[0]?.schedule?.[0]?.date).toBe("2025-06-17");
    expect(sailing?.tours?.[0]?.schedule?.[2]?.date).toBe("2025-06-19");
    expect(sailing?.tours?.[1]?.tourCode).toBe("A7R05A");
    expect(sailing?.tours?.[1]?.tourTypeCode).toBe("POST");
    // Post-tour: sailDate 2025-06-20, cruise 7 → day 1 = 2025-06-27
    expect(sailing?.tours?.[1]?.schedule?.[0]?.date).toBe("2025-06-27");
  });

  it("emits preTour without dates when duration is null/zero", () => {
    // Defensive branch: if RC returns a preTour with no duration, the
    // anchor date can't be computed. Schedule entries must still
    // emit (VPS clients expect the tour object even without dates),
    // just with undefined date fields.
    const cruise = buildCruise({
      sailings: [{ id: "s-1", sailDate: "2025-06-20", stateroomClassPricing: [] }],
      masterSailing: {
        itinerary: {
          code: "AN07",
          totalNights: 7,
          ship: { code: "AN" },
          preTour: {
            code: "ZZZ",
            duration: null,
            days: [{ number: 1, ports: [{ activity: "LAND", port: { code: "ANC" } }] }],
          },
        },
      },
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
    });
    expect(sailing?.tours?.[0]?.duration).toBeUndefined();
    expect(sailing?.tours?.[0]?.schedule?.[0]?.date).toBeUndefined();
    expect(sailing?.tours?.[0]?.schedule?.[0]?.portCode).toBe("ANC");
  });

  it("omits tours[] when both preTour and postTour are null (the common case)", () => {
    // buildCruise's default itinerary has neither — most sailings are
    // cruise-only, no land extension.
    const [sailing] = expandCruiseToSailings(buildCruise(), {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.tours).toBeUndefined();
  });

  it("surfaces sailing.status as sailingStatus and derives cruiseOnly", () => {
    const cruiseWithStatus = buildCruise({
      sailings: [
        {
          id: "s-1",
          sailDate: "2026-06-07",
          status: "OPEN",
          stateroomClassPricing: [],
        },
      ],
    });
    const [sailing] = expandCruiseToSailings(cruiseWithStatus, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.sailingStatus).toBe("OPEN");
    // Default buildCruise has no preTour/postTour → cruiseOnly=true
    expect(sailing?.cruiseOnly).toBe(true);
  });

  it("derives cruiseOnly=false when preTour or postTour is attached", () => {
    const cruise = buildCruise({
      masterSailing: {
        itinerary: {
          code: "AN09AA11",
          totalNights: 9,
          ship: { code: "AN" },
          days: [{ number: 1, ports: [{ activity: "EMBARK", port: { code: "SEW" } }] }],
          postTour: { code: "A7R11A", duration: 2, days: [] },
        },
      },
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.cruiseOnly).toBe(false);
  });

  it("derives schedule entry date from sailDate + dayNumber", () => {
    // VPS fixture emits a date on every schedule row. RC's Day type has
    // no date field, so we compute sailDate + (dayNumber - 1) per sailing.
    // Two sailings of the same cruise should get different schedule dates.
    const cruise = buildCruise({
      sailings: [
        {
          id: "s-1",
          sailDate: "2026-06-07",
          stateroomClassPricing: [],
        },
        {
          id: "s-2",
          sailDate: "2026-07-12",
          stateroomClassPricing: [],
        },
      ],
      masterSailing: {
        itinerary: {
          code: "WN04B001",
          totalNights: 4,
          ship: { code: "WN" },
          days: [
            { number: 1, ports: [{ activity: "EMBARK", port: { code: "MIA" } }] },
            { number: 2, ports: [{ activity: "DOCKED", port: { code: "NAS" } }] },
          ],
        },
      },
    });
    const sailings = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-07-31",
    });
    expect(sailings).toHaveLength(2);
    expect(sailings[0]?.sailingItinerary?.schedule[0]?.date).toBe("2026-06-07");
    expect(sailings[0]?.sailingItinerary?.schedule[1]?.date).toBe("2026-06-08");
    expect(sailings[1]?.sailingItinerary?.schedule[0]?.date).toBe("2026-07-12");
    expect(sailings[1]?.sailingItinerary?.schedule[1]?.date).toBe("2026-07-13");
  });

  it("surfaces itinerary type + voyageType from the GraphQL response", () => {
    const cruise = buildCruise({
      masterSailing: {
        itinerary: {
          code: "SC02I142",
          totalNights: 2,
          type: "CRUISE",
          voyageType: "OCEAN",
          ship: { code: "SC" },
          days: [{ number: 1, ports: [{ activity: "EMBARK", port: { code: "HKG" } }] }],
        },
      },
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    expect(sailing?.sailingItinerary?.itineraryType).toBe("CRUISE");
    expect(sailing?.sailingItinerary?.voyageType).toBe("OCEAN");
  });

  it("suppresses tours[] when includeTourPackages=false even if preTour is set", () => {
    // VPS request lets clients opt out of tour packages. The flag
    // should gate the field at the output, not the query.
    const cruise = buildCruise({
      masterSailing: {
        itinerary: {
          code: "AN09AA11",
          totalNights: 9,
          ship: { code: "AN" },
          preTour: { code: "A5R09B", duration: 3, days: [{ number: 1, ports: [] }] },
        },
      },
    });
    const [sailing] = expandCruiseToSailings(cruise, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
      includeTourPackages: false,
    });
    expect(sailing?.tours).toBeUndefined();
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

  // Production calls from services/sailing-catalog never pass options.fetchFn,
  // so the defaultFetch wrapper that routes to cruiseSearchCruises is the
  // code path that actually runs in prod. Stubbing global fetch proves the
  // wiring — a broken wrapper would silently no-op without this test.
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
      const sailings = await fetchSailingPackagesViaGraphql(
        {
          brandCode: "R",
          fromSailDate: "2026-06-01",
          toSailDate: "2026-07-31",
          shipCodes: ["WN"],
        },
        { pageSize: 1, maxPages: 1 }
      );
      expect(sailings.length).toBeGreaterThan(0);
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
