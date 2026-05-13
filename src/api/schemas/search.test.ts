import { describe, expect, it } from "vitest";

import { searchRequestSchema } from "@/api/schemas/search";

/**
 * Pins the POST /v1/search body contract end-to-end at the Zod layer —
 * route tests (routes.e2e.test.ts) only exercise happy-path + shape, so
 * field-level validation (regexes, bounds, refinements) lives here.
 */

const minimal = {
  fromSailDate: "2026-06-01",
  toSailDate: "2026-06-30",
};

describe("searchRequestSchema", () => {
  it("defaults brandCode to R when omitted", () => {
    const parsed = searchRequestSchema.parse(minimal);
    expect(parsed.brandCode).toBe("R");
    expect(parsed.includeTourPackages).toBe(false);
  });

  it("accepts the full Task 8 filter set and passes through", () => {
    const parsed = searchRequestSchema.parse({
      ...minimal,
      shipCodes: ["WN", "IC"],
      destinations: ["CARIB", "BAHAM"],
      departurePorts: ["MIA", "FLL"],
      cruiseLengthRange: { min: 5, max: 7 },
      guestCount: 2,
      cabinType: "BALCONY",
      includeTourPackages: true,
    });
    expect(parsed.destinations).toEqual(["CARIB", "BAHAM"]);
    expect(parsed.departurePorts).toEqual(["MIA", "FLL"]);
    expect(parsed.cruiseLengthRange).toEqual({ min: 5, max: 7 });
    expect(parsed.guestCount).toBe(2);
    expect(parsed.cabinType).toBe("BALCONY");
  });

  it("rejects lowercase destination codes", () => {
    expect(() => searchRequestSchema.parse({ ...minimal, destinations: ["carib"] })).toThrow();
  });

  it("rejects a destination code outside the 3-6 char range", () => {
    expect(() => searchRequestSchema.parse({ ...minimal, destinations: ["XX"] })).toThrow();
    expect(() =>
      searchRequestSchema.parse({ ...minimal, destinations: ["TOOLONGCODE"] })
    ).toThrow();
  });

  it("rejects a departure port that is not exactly 3 letters", () => {
    expect(() => searchRequestSchema.parse({ ...minimal, departurePorts: ["MI"] })).toThrow();
    expect(() => searchRequestSchema.parse({ ...minimal, departurePorts: ["MIAMI"] })).toThrow();
  });

  it("rejects cruiseLengthRange where min > max", () => {
    expect(() =>
      searchRequestSchema.parse({
        ...minimal,
        cruiseLengthRange: { min: 7, max: 5 },
      })
    ).toThrow();
  });

  it("rejects cruiseLengthRange with out-of-bounds values", () => {
    expect(() =>
      searchRequestSchema.parse({
        ...minimal,
        cruiseLengthRange: { min: 0, max: 7 },
      })
    ).toThrow();
    expect(() =>
      searchRequestSchema.parse({
        ...minimal,
        cruiseLengthRange: { min: 7, max: 999 },
      })
    ).toThrow();
  });

  it("rejects a guestCount outside 1..8", () => {
    expect(() => searchRequestSchema.parse({ ...minimal, guestCount: 0 })).toThrow();
    expect(() => searchRequestSchema.parse({ ...minimal, guestCount: 9 })).toThrow();
  });

  it("rejects unknown cabinType values", () => {
    expect(() => searchRequestSchema.parse({ ...minimal, cabinType: "PRESIDENTIAL" })).toThrow();
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() => searchRequestSchema.parse({ ...minimal, nights: 7 })).toThrow();
  });
});
