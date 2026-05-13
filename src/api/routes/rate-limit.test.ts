import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "@/server";
import * as sailingCatalogService from "@/services/sailing-catalog";

/**
 * Verifies that the inbound Fastify rate limiter emits a VPS envelope
 * with code 1010 THROTTLED_REQUEST on flood — Task 11's "cap inbound
 * API requests" requirement. We force RATE_LIMIT_MAX to a tiny number
 * so we can trip it within a handful of requests.
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

describe("inbound rate limiting (Task 11)", () => {
  const appRef: { value: Awaited<ReturnType<typeof buildServer>> | null } = { value: null };
  const preserved = {
    RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX,
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = "2";
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "development";
    vi.mocked(sailingCatalogService.getSailingPackages).mockResolvedValue({
      status: { httpStatus: "OK", dateTime: "x", details: [] },
      sailingPackages: [],
    } as never);
    appRef.value = await buildServer();
    await appRef.value.ready();
  });

  afterAll(async () => {
    if (appRef.value) await appRef.value.close();
    process.env.RATE_LIMIT_MAX = preserved.RATE_LIMIT_MAX;
    process.env.DEV_BYPASS_AUTH = preserved.DEV_BYPASS_AUTH;
    process.env.NODE_ENV = preserved.NODE_ENV;
  });

  it("emits a VPS envelope with code 1010 after the limit is crossed", async () => {
    const app = appRef.value;
    if (!app) throw new Error("app not initialized");
    const url =
      "/v1/catalog/sailing-package?brandCode=R&fromSailDate=2025-06-01&toSailDate=2025-06-30";
    const headers = { "content-type": "application/json" };
    // First two hit the limit; third trips it.
    const responses = [
      await app.inject({ method: "GET", url, headers }),
      await app.inject({ method: "GET", url, headers }),
      await app.inject({ method: "GET", url, headers }),
    ];
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.includes(429)).toBe(true);

    const limited = responses.find((r) => r.statusCode === 429);
    if (!limited) throw new Error("rate limit never tripped");
    const body = limited.json();
    expect(body.status.httpStatus).toBe("TOO_MANY_REQUESTS");
    expect(body.status.details[0].code).toBe(1010);
    expect(body.status.details[0].codeDescription).toBe("THROTTLED_REQUEST");
  });
});
