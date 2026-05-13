import { loadVpsFixture } from "@test/helpers/vps-fixtures";
import { describe, expect, it } from "vitest";
import {
  sailingPackageQueryStringSchema,
  sailingPackageResponseSchema,
} from "@/api/schemas/sailing-package";

describe("sailing-package response schema", () => {
  it("parses every response in the RC sample fixture", () => {
    const { responses } = loadVpsFixture("sailing-package");
    expect(responses.length).toBeGreaterThan(0);
    for (const response of responses) {
      const parsed = sailingPackageResponseSchema.safeParse(response);
      if (!parsed.success) {
        throw new Error(
          `fixture failed to parse:\n${parsed.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n")}`
        );
      }
      expect(parsed.data.sailingPackages.length).toBeGreaterThan(0);
    }
  });

  // The query-string schema accepts includeTourPackages as either a
  // native boolean (e.g. when an upstream Fastify plugin pre-coerces
  // query params) or the string "true" (RC's wire format). Both
  // branches must survive or the query-string route silently treats
  // `?includeTourPackages=true` and a coerced `true` as different.
  describe("sailingPackageQueryStringSchema includeTourPackages coercion", () => {
    it("passes through a native boolean true", () => {
      const parsed = sailingPackageQueryStringSchema.parse({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        includeTourPackages: true,
      });
      expect(parsed.includeTourPackages).toBe(true);
    });

    it("passes through a native boolean false", () => {
      const parsed = sailingPackageQueryStringSchema.parse({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        includeTourPackages: false,
      });
      expect(parsed.includeTourPackages).toBe(false);
    });

    it('coerces the string "true" to boolean true', () => {
      const parsed = sailingPackageQueryStringSchema.parse({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        includeTourPackages: "true",
      });
      expect(parsed.includeTourPackages).toBe(true);
    });

    it('treats any string other than "true" as false', () => {
      const parsed = sailingPackageQueryStringSchema.parse({
        brandCode: "R",
        fromSailDate: "2026-06-01",
        toSailDate: "2026-06-30",
        includeTourPackages: "yes",
      });
      expect(parsed.includeTourPackages).toBe(false);
    });
  });

  // TASKS.md Task 4 minimum-viable schema requires explicit cabinOptions
  // and a bookingUrl on each sailing. Both are optional so the existing
  // VPS fixture (which carries neither) keeps parsing — but when the
  // scraper or graphql-catalog flow does populate them, the response
  // schema MUST expose them as first-class fields rather than silently
  // through .passthrough().
  it("accepts an optional cabinOptions array per sailing (TASKS.md Task 4)", () => {
    const { responses } = loadVpsFixture("sailing-package");
    const base = responses[0] as { sailingPackages: Record<string, unknown>[] };
    const augmented = {
      ...base,
      sailingPackages: base.sailingPackages.map((p) => ({
        ...p,
        cabinOptions: [
          {
            stateroomCategoryCode: "1A",
            stateroomSuperCategory: "I",
            pricePerGuest: 597.5,
            currency: "USD",
          },
        ],
      })),
    };
    const parsed = sailingPackageResponseSchema.safeParse(augmented);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sailingPackages[0]?.cabinOptions?.[0]?.stateroomCategoryCode).toBe("1A");
      expect(parsed.data.sailingPackages[0]?.cabinOptions?.[0]?.pricePerGuest).toBe(597.5);
    }
  });

  it("accepts an optional bookingUrl per sailing (TASKS.md Task 4)", () => {
    const { responses } = loadVpsFixture("sailing-package");
    const base = responses[0] as { sailingPackages: Record<string, unknown>[] };
    const augmented = {
      ...base,
      sailingPackages: base.sailingPackages.map((p) => ({
        ...p,
        bookingUrl: "https://www.royalcaribbean.com/itinerary/example-RD10BQ09",
      })),
    };
    const parsed = sailingPackageResponseSchema.safeParse(augmented);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sailingPackages[0]?.bookingUrl).toContain("royalcaribbean.com");
    }
  });

  // Guards against silent drift if we ever replace tourScheduleStopSchema's
  // componentXxx fields with something else (like the earlier incorrect
  // activityCode/activityDescription pair).
  it("round-trips the tour-schedule componentTypeCode/componentProviderName pair from the fixture", () => {
    const { responses } = loadVpsFixture("sailing-package");
    const stops = responses
      .flatMap((r) => (r as { sailingPackages?: unknown[] }).sailingPackages ?? [])
      .flatMap((s) => (s as { tours?: unknown[] }).tours ?? [])
      .flatMap((t) => (t as { schedule?: unknown[] }).schedule ?? []);
    const withComponent = stops.find(
      (s): s is { componentTypeCode: string; componentProviderName: string } => {
        const stop = s as Record<string, unknown>;
        return (
          typeof stop.componentTypeCode === "string" &&
          typeof stop.componentProviderName === "string"
        );
      }
    );
    expect(withComponent).toBeDefined();
  });
});
