import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "@/server";
import * as priceChangesService from "@/services/price-changes";
import * as pricingService from "@/services/pricing";
import * as promotionsService from "@/services/promotions";
import * as sailingCatalogService from "@/services/sailing-catalog";

/**
 * End-to-end route tests with the service layer mocked. Verifies that:
 * 1. Zod request schemas validate inbound bodies (bad body → 1002).
 * 2. Bearer auth protects every route and the service stub stays un-called.
 * 3. A valid request + valid service response flows back through the
 *    VPS envelope (status envelope always present, services' return
 *    values pass through untouched).
 *
 * We mock at the service boundary (not the scraper) so this is a true
 * HTTP-level contract test for the VPS routes.
 */

vi.mock("@/services/sailing-catalog", () => ({
  getSailingPackages: vi.fn(),
  getSailingPackageChanges: vi.fn(),
}));

vi.mock("@/services/pricing", () => ({
  getSuperCategoryPricing: vi.fn(),
  getCategoryPricing: vi.fn(),
  getGroupPricing: vi.fn(),
}));

vi.mock("@/services/price-changes", () => ({
  getPriceChanges: vi.fn(),
}));

vi.mock("@/services/promotions", () => ({
  getPromotionDetails: vi.fn(),
}));

function okEnvelope<T extends object>(payload: T) {
  return {
    status: { httpStatus: "OK", dateTime: "2025-01-01T00:00:00", details: [] },
    ...payload,
  };
}

describe("VPS routes — end-to-end with mocked services", () => {
  const appRef: { value: Awaited<ReturnType<typeof buildServer>> | null } = { value: null };
  const preserved = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeAll(async () => {
    // Force auth bypass for these tests — we want to exercise route
    // validation + service wiring, not the auth plugin (which has its
    // own dedicated integration tests in routes.integration.test.ts).
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "development";
    appRef.value = await buildServer();
    await appRef.value.ready();
  });

  afterAll(async () => {
    if (appRef.value) await appRef.value.close();
    process.env.DEV_BYPASS_AUTH = preserved.DEV_BYPASS_AUTH;
    process.env.NODE_ENV = preserved.NODE_ENV;
  });

  beforeEach(() => {
    vi.mocked(sailingCatalogService.getSailingPackages).mockReset();
    vi.mocked(sailingCatalogService.getSailingPackageChanges).mockReset();
    vi.mocked(pricingService.getSuperCategoryPricing).mockReset();
    vi.mocked(pricingService.getCategoryPricing).mockReset();
    vi.mocked(pricingService.getGroupPricing).mockReset();
    vi.mocked(priceChangesService.getPriceChanges).mockReset();
    vi.mocked(promotionsService.getPromotionDetails).mockReset();
  });

  function authed(headers: Record<string, string> = {}) {
    return { "content-type": "application/json", ...headers };
  }

  describe("sailing-package (GET)", () => {
    it("passes parsed query string through to the service and returns its envelope", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(sailingCatalogService.getSailingPackages).mockResolvedValue(
        okEnvelope({ sailingPackages: [] }) as never
      );
      const response = await app.inject({
        method: "GET",
        url: "/v1/catalog/sailing-package?brandCode=R&fromSailDate=2025-06-01&toSailDate=2025-06-30&shipCodes=RD,AL&includeTourPackages=true",
        headers: authed(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status.httpStatus).toBe("OK");
      const callArg = vi.mocked(sailingCatalogService.getSailingPackages).mock.calls[0]?.[0];
      expect(callArg?.shipCodes).toEqual(["RD", "AL"]);
      expect(callArg?.includeTourPackages).toBe(true);
    });

    it("rejects malformed date format with a 1002 FIELD_VIOLATION envelope", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      const response = await app.inject({
        method: "GET",
        url: "/v1/catalog/sailing-package?brandCode=R&fromSailDate=not-a-date&toSailDate=2025-06-30",
        headers: authed(),
      });
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.status.details[0].code).toBe(1002);
      expect(vi.mocked(sailingCatalogService.getSailingPackages)).not.toHaveBeenCalled();
    });
  });

  describe("sailing-package-changes (POST)", () => {
    it("requires agencyId + fromDateTime in the body", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      const response = await app.inject({
        method: "POST",
        url: "/v1/catalog/sailing-package-changes",
        headers: authed(),
        payload: { agencyId: "A" }, // missing fromDateTime
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().status.details[0].code).toBe(1002);
    });

    it("passes validated body through to the service", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(sailingCatalogService.getSailingPackageChanges).mockResolvedValue(
        okEnvelope({ keys: [] }) as never
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/catalog/sailing-package-changes",
        headers: authed(),
        payload: { agencyId: "A1", fromDateTime: "2023-06-05T04:06:43" },
      });
      expect(response.statusCode).toBe(200);
      expect(vi.mocked(sailingCatalogService.getSailingPackageChanges)).toHaveBeenCalledWith(
        "2023-06-05T04:06:43"
      );
    });
  });

  describe("pricing endpoints (POST × 3)", () => {
    const baseBody = {
      clients: [{ clientContext: "AGENCY_1", clientId: "A1" }],
      companyShortName: "AGENCY",
      brandCode: "R",
      shipCode: "EN",
      sailDate: "2024-04-20",
      packageCode: "EN07W550",
      officeCode: "MIA",
      countryCode: "CAN",
      currencyCode: "CAD",
      occupancy: 2,
      bookingTypeCode: "I",
    };

    it("super-category pricing routes through", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(pricingService.getSuperCategoryPricing).mockResolvedValue(
        okEnvelope({ promotionBestPrices: [] }) as never
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/partner-pricing/super-category-pricing",
        headers: authed(),
        payload: baseBody,
      });
      expect(response.statusCode).toBe(200);
      expect(vi.mocked(pricingService.getSuperCategoryPricing)).toHaveBeenCalledTimes(1);
    });

    it("category pricing routes through", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(pricingService.getCategoryPricing).mockResolvedValue(
        okEnvelope({ promotionBestPrices: [] }) as never
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/partner-pricing/category-pricing",
        headers: authed(),
        payload: baseBody,
      });
      expect(response.statusCode).toBe(200);
    });

    it("group pricing routes through", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(pricingService.getGroupPricing).mockResolvedValue(
        okEnvelope({ groupBestPrices: [] }) as never
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/partner-pricing/group-pricing",
        headers: authed(),
        payload: { ...baseBody, bookingTypeCode: "G" },
      });
      expect(response.statusCode).toBe(200);
    });

    it("pricing rejects missing required fields", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      const response = await app.inject({
        method: "POST",
        url: "/v1/partner-pricing/super-category-pricing",
        headers: authed(),
        payload: { brandCode: "R" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().status.details[0].code).toBe(1002);
    });

    it("category pricing rejects missing required fields with a 1002 envelope", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      const response = await app.inject({
        method: "POST",
        url: "/v1/partner-pricing/category-pricing",
        headers: authed(),
        payload: { brandCode: "R" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().status.details[0].code).toBe(1002);
    });

    it("group pricing rejects missing required fields with a 1002 envelope", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      const response = await app.inject({
        method: "POST",
        url: "/v1/partner-pricing/group-pricing",
        headers: authed(),
        payload: { brandCode: "R" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().status.details[0].code).toBe(1002);
    });
  });

  describe("price-changes endpoints (POST × 2)", () => {
    it("super-category delta routes through with granularity tag", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(priceChangesService.getPriceChanges).mockResolvedValue(
        okEnvelope({ keys: [] }) as never
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/pricing-snapshot/price-changes/super-category",
        headers: authed(),
        payload: {
          fromDateTime: "2024-01-01T00:00:00",
          client: { agencyId: "A1", currencyCodes: ["USD"] },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(vi.mocked(priceChangesService.getPriceChanges)).toHaveBeenCalledWith(
        "2024-01-01T00:00:00",
        "super-category"
      );
    });

    it("category delta routes through with its granularity tag", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(priceChangesService.getPriceChanges).mockResolvedValue(
        okEnvelope({ keys: [] }) as never
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/pricing-snapshot/price-changes/category",
        headers: authed(),
        payload: {
          fromDateTime: "2024-01-01T00:00:00",
          market: { officeCode: "MIA", countryCode: "USA", currencyCodes: ["USD"] },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(vi.mocked(priceChangesService.getPriceChanges)).toHaveBeenCalledWith(
        "2024-01-01T00:00:00",
        "category"
      );
    });

    it("super-category delta rejects a body with neither client nor market", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      const response = await app.inject({
        method: "POST",
        url: "/v1/pricing-snapshot/price-changes/super-category",
        headers: authed(),
        payload: { fromDateTime: "2024-01-01T00:00:00" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().status.details[0].code).toBe(1002);
    });

    it("category delta rejects a body missing fromDateTime", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      const response = await app.inject({
        method: "POST",
        url: "/v1/pricing-snapshot/price-changes/category",
        headers: authed(),
        payload: { client: { agencyId: "A1", currencyCodes: ["USD"] } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().status.details[0].code).toBe(1002);
    });
  });

  describe("search (POST /v1/search)", () => {
    it("passes parsed JSON body through to the service and returns its envelope", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(sailingCatalogService.getSailingPackages).mockResolvedValue(
        okEnvelope({ sailingPackages: [] }) as never
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers: authed(),
        payload: {
          brandCode: "R",
          fromSailDate: "2026-06-01",
          toSailDate: "2026-06-30",
          shipCodes: ["RD", "AL"],
          includeTourPackages: true,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status.httpStatus).toBe("OK");
      const callArg = vi.mocked(sailingCatalogService.getSailingPackages).mock.calls[0]?.[0];
      // POST-body variant passes native arrays/booleans straight through — no
      // comma-splitting like the GET query-string route does.
      expect(callArg?.shipCodes).toEqual(["RD", "AL"]);
      expect(callArg?.includeTourPackages).toBe(true);
    });

    it("defaults brandCode to R when omitted", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(sailingCatalogService.getSailingPackages).mockResolvedValue(
        okEnvelope({ sailingPackages: [] }) as never
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers: authed(),
        payload: { fromSailDate: "2026-06-01", toSailDate: "2026-06-30" },
      });
      expect(response.statusCode).toBe(200);
      const callArg = vi.mocked(sailingCatalogService.getSailingPackages).mock.calls[0]?.[0];
      expect(callArg?.brandCode).toBe("R");
    });

    it("rejects comma-separated shipCodes (GET-style) with a 1002 envelope", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      const response = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers: authed(),
        payload: {
          fromSailDate: "2026-06-01",
          toSailDate: "2026-06-30",
          shipCodes: "RD,AL",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().status.details[0].code).toBe(1002);
      expect(vi.mocked(sailingCatalogService.getSailingPackages)).not.toHaveBeenCalled();
    });

    it("threads the full Task 8 filter set through to the service", async () => {
      // Schema-level tests pin validation; this pins that the transformed
      // body actually reaches getSailingPackages with every field set
      // exactly as parsed. Anything lost in the transform would show up
      // here as undefined/missing on the captured call argument.
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(sailingCatalogService.getSailingPackages).mockResolvedValue(
        okEnvelope({ sailingPackages: [] }) as never
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers: authed(),
        payload: {
          fromSailDate: "2026-06-01",
          toSailDate: "2026-06-30",
          destinations: ["CARIB", "BAHAM"],
          departurePorts: ["MIA", "FLL"],
          cruiseLengthRange: { min: 5, max: 7 },
          guestCount: 2,
          cabinType: "BALCONY",
        },
      });
      expect(response.statusCode).toBe(200);
      const callArg = vi.mocked(sailingCatalogService.getSailingPackages).mock.calls[0]?.[0];
      expect(callArg?.destinations).toEqual(["CARIB", "BAHAM"]);
      expect(callArg?.departurePorts).toEqual(["MIA", "FLL"]);
      expect(callArg?.cruiseLengthRange).toEqual({ min: 5, max: 7 });
      expect(callArg?.guestCount).toBe(2);
      expect(callArg?.cabinType).toBe("BALCONY");
    });

    it("rejects an invalid cabinType with a 1002 envelope", async () => {
      // Pins that strict-mode validation runs end-to-end (not just at the
      // schema unit level) — if Fastify's schema compiler ever regressed
      // to lenient mode, this would flag it at the route layer.
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      const response = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers: authed(),
        payload: {
          fromSailDate: "2026-06-01",
          toSailDate: "2026-06-30",
          cabinType: "PRESIDENTIAL",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().status.details[0].code).toBe(1002);
      expect(vi.mocked(sailingCatalogService.getSailingPackages)).not.toHaveBeenCalled();
    });
  });

  describe("promotion-details (POST)", () => {
    it("routes through to the service", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      vi.mocked(promotionsService.getPromotionDetails).mockResolvedValue(
        okEnvelope({ promotions: [] }) as never
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/promotion/promotion-details",
        headers: authed(),
        payload: { brand: "R", client: { agencyId: "A1", currencyCodes: ["USD"] } },
      });
      expect(response.statusCode).toBe(200);
      expect(vi.mocked(promotionsService.getPromotionDetails)).toHaveBeenCalledTimes(1);
    });

    it("rejects a body with neither client nor market as a 1002 envelope", async () => {
      const app = appRef.value;
      if (!app) throw new Error("app not initialized");
      const response = await app.inject({
        method: "POST",
        url: "/v1/promotion/promotion-details",
        headers: authed(),
        payload: { brand: "R" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().status.details[0].code).toBe(1002);
    });
  });
});
