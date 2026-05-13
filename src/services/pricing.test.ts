import { beforeEach, describe, expect, it, vi } from "vitest";

import { categoryPricingResponseSchema } from "@/api/schemas/category-pricing";
import { groupPricingResponseSchema } from "@/api/schemas/group-pricing";
import { superCategoryPricingResponseSchema } from "@/api/schemas/super-category-pricing";
import { clearResponseCache } from "@/cache/response-cache";
import { EmptyResultsError } from "@/scraper/errors";
import { fetchSailingPricingViaGraphql } from "@/scraper/flows/graphql-pricing";
import { scrapeSailingPricing } from "@/scraper/flows/pricing";
import { runWithSession } from "@/scraper/pool";
import { getCategoryPricing, getGroupPricing, getSuperCategoryPricing } from "@/services/pricing";
import { savePricingSnapshot } from "@/snapshots/store";

// Hoisted logger stub so we can assert on the "graphql super-category
// lookup failed" warn log — the signal ops use to decide whether a
// snapshot-fallback spike has a matching upstream cause.
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

vi.mock("@/scraper/flows/graphql-pricing", () => ({
  fetchSailingPricingViaGraphql: vi.fn(),
}));

vi.mock("@/scraper/flows/pricing", () => ({
  scrapeSailingPricing: vi.fn(),
}));

vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn(),
}));

vi.mock("@/snapshots/store", () => ({
  savePricingSnapshot: vi.fn(),
}));

function fakeRequest() {
  return {
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
}

function fakeCabins() {
  return [
    {
      stateroomCategoryCode: "2J",
      stateroomSuperCategory: "B",
      stateroomTypeCode: "J",
      refundableFareFlag: true,
      accessibleStateroomExistFlag: false,
      pricePerGuest: 1406,
      netCruiseFareAmount: 1231,
      taxesAndFeesAmount: 180,
      originalAmount: 2219,
      leadPromotionShortDescription: "BOGO60",
    },
    {
      stateroomCategoryCode: "J3",
      stateroomSuperCategory: "D",
      stateroomTypeCode: "JS",
      refundableFareFlag: true,
      accessibleStateroomExistFlag: true,
      pricePerGuest: 710,
      netCruiseFareAmount: 500,
      taxesAndFeesAmount: 152,
      originalAmount: 3789,
    },
  ];
}

describe("services/pricing", () => {
  beforeEach(() => {
    clearResponseCache();
    vi.mocked(fetchSailingPricingViaGraphql).mockReset();
    vi.mocked(fetchSailingPricingViaGraphql).mockResolvedValue(null);
    vi.mocked(runWithSession).mockReset();
    vi.mocked(savePricingSnapshot).mockReset();
  });

  it("getSuperCategoryPricing answers from graphql when the sailing is in the catalog", async () => {
    vi.mocked(fetchSailingPricingViaGraphql).mockResolvedValue({
      sailing: { id: "s-1", sailDate: "2024-04-20" },
      stateroomClassPricing: [
        {
          price: {
            value: 599.5,
            netAmount: 500,
            taxesAndFeesAmount: 99,
            currency: { code: "CAD" },
          },
          stateroomClass: { id: "I", content: { code: "I" } },
        },
        {
          price: { value: 899.0, currency: { code: "CAD" } },
          stateroomClass: { id: "B", content: { code: "B" } },
        },
      ],
    });
    const response = await getSuperCategoryPricing(fakeRequest());
    expect(superCategoryPricingResponseSchema.safeParse(response).success).toBe(true);
    const codes =
      response.promotionBestPrices[0]?.superCategoryBestPrices
        .map((e) => e.superCategoryCode)
        .sort() ?? [];
    expect(codes).toEqual(["B", "I"]);
    expect(vi.mocked(runWithSession)).not.toHaveBeenCalled();
  });

  it("persists a super-category snapshot when answered via graphql (so the delta endpoint sees it)", async () => {
    vi.mocked(fetchSailingPricingViaGraphql).mockResolvedValue({
      sailing: { id: "s-1", sailDate: "2024-04-20" },
      stateroomClassPricing: [
        {
          price: {
            value: 599.5,
            netAmount: 500,
            taxesAndFeesAmount: 99,
            originalAmount: 699,
            currency: { code: "CAD" },
          },
          stateroomClass: { id: "I", content: { code: "I" } },
        },
      ],
    });
    await getSuperCategoryPricing(fakeRequest());
    expect(vi.mocked(savePricingSnapshot)).toHaveBeenCalledTimes(1);
    const [key, payload] = vi.mocked(savePricingSnapshot).mock.calls[0] ?? [];
    expect(key?.granularity).toBe("super-category");
    expect(key?.shipCode).toBe("EN");
    expect(key?.packageCode).toBe("EN07W550");
    expect(payload).toEqual([
      expect.objectContaining({
        stateroomCategoryCode: "I",
        stateroomSuperCategory: "I",
        pricePerGuest: 599.5,
        netCruiseFareAmount: 500,
        taxesAndFeesAmount: 99,
        originalAmount: 699,
      }),
    ]);
  });

  it("getSuperCategoryPricing falls back to Stagehand when graphql has no match", async () => {
    vi.mocked(fetchSailingPricingViaGraphql).mockResolvedValue(null);
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const response = await getSuperCategoryPricing(fakeRequest());
    expect(superCategoryPricingResponseSchema.safeParse(response).success).toBe(true);
    const entries = response.promotionBestPrices[0]?.superCategoryBestPrices ?? [];
    const codes = entries.map((e) => e.superCategoryCode).sort();
    expect(codes).toEqual(["B", "D"]);
    expect(vi.mocked(runWithSession)).toHaveBeenCalledTimes(1);
  });

  it("getSuperCategoryPricing falls back to Stagehand when graphql throws", async () => {
    // A GraphQL-level failure (HTTP 5xx, JSON parse error, etc.) must
    // downgrade to the Stagehand path rather than bubble up as a 500 —
    // otherwise a transient upstream error takes super-category
    // pricing offline for everyone.
    loggerStub.warn.mockClear();
    vi.mocked(fetchSailingPricingViaGraphql).mockRejectedValue(new Error("graphql upstream 503"));
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const response = await getSuperCategoryPricing(fakeRequest());
    expect(superCategoryPricingResponseSchema.safeParse(response).success).toBe(true);
    expect(vi.mocked(runWithSession)).toHaveBeenCalledTimes(1);
    // Pin the ops signal — a refactor that swallowed the warn would hide
    // graphql upstream pain from the log pipeline.
    const msg = loggerStub.warn.mock.calls
      .map((c) => c[0] as string)
      .find((m) => /graphql super-category lookup failed/.test(m));
    expect(msg).toMatch(/graphql upstream 503/);
  });

  it("getCategoryPricing emits one row per stateroom category and round-trips", async () => {
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const response = await getCategoryPricing(fakeRequest());
    expect(categoryPricingResponseSchema.safeParse(response).success).toBe(true);
    expect(response.categoryBestPrices).toHaveLength(2);
  });

  it("getCategoryPricing narrows to a specific categoryCode when provided", async () => {
    // Previously `categoryCode` on the request was accepted by the schema
    // but silently ignored by the service — callers paid the scrape cost
    // and then had to filter on their own. Confirm the field flows end
    // to end now: two cabins scraped, categoryCode=J3 filters to one.
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const response = await getCategoryPricing({ ...fakeRequest(), categoryCode: "J3" });
    expect(categoryPricingResponseSchema.safeParse(response).success).toBe(true);
    expect(response.categoryBestPrices).toHaveLength(1);
    expect(response.categoryBestPrices?.[0]?.stateroomCategoryCode).toBe("J3");
  });

  it("getCategoryPricing returns all cabins when categoryCode is omitted", async () => {
    // Sanity-check that the filter is opt-in, not accidentally active.
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const response = await getCategoryPricing(fakeRequest());
    expect(response.categoryBestPrices).toHaveLength(2);
  });

  it("getCategoryPricing returns an empty list when the requested categoryCode is absent", async () => {
    // An unknown code isn't an error — clients querying speculatively get
    // a well-formed empty response (consistent with Task 10's contract).
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const response = await getCategoryPricing({
      ...fakeRequest(),
      categoryCode: "DOES_NOT_EXIST",
    });
    expect(response.categoryBestPrices).toHaveLength(0);
  });

  it("getGroupPricing wraps category rows in a synthetic group shell and round-trips", async () => {
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const response = await getGroupPricing(fakeRequest());
    expect(groupPricingResponseSchema.safeParse(response).success).toBe(true);
    expect(response.groupBestPrices).toHaveLength(1);
    expect(response.groupBestPrices[0]?.groupId).toBe("PUBLIC");
    expect(response.groupBestPrices[0]?.allocatedCategoryBestPrices).toHaveLength(2);
  });

  it("passes brand/ship/sailDate/package/occupancy/currency/bookingType to scrapeSailingPricing", async () => {
    // Covers the runWithSession callback body in services/pricing.ts:55-68.
    // Previously runWithSession mocks bypassed scrapeSailingPricing, so
    // a bug in the input-mapping would slip through every test.
    vi.mocked(fetchSailingPricingViaGraphql).mockResolvedValue(null);
    vi.mocked(runWithSession).mockImplementation(async (task) =>
      task({
        sessionId: "test",
        stagehand: {} as never,
        limiter: {} as never,
        close: async () => undefined,
      })
    );
    vi.mocked(scrapeSailingPricing).mockResolvedValue(fakeCabins());
    await getSuperCategoryPricing(fakeRequest());
    expect(vi.mocked(scrapeSailingPricing)).toHaveBeenCalledOnce();
    const [, input] = vi.mocked(scrapeSailingPricing).mock.calls[0] ?? [];
    expect(input).toMatchObject({
      brandCode: "R",
      shipCode: "EN",
      sailDate: "2024-04-20",
      packageCode: "EN07W550",
      occupancy: 2,
      currencyCode: "CAD",
      bookingTypeCode: "I",
    });
  });

  it("EmptyResultsError from scraper yields empty pricing response (Task 10)", async () => {
    vi.mocked(fetchSailingPricingViaGraphql).mockResolvedValue(null);
    vi.mocked(runWithSession).mockRejectedValue(new EmptyResultsError());
    const response = await getSuperCategoryPricing(fakeRequest());
    expect(response.status.httpStatus).toBe("OK");
    expect(response.promotionBestPrices).toHaveLength(1);
    expect(response.promotionBestPrices[0]?.superCategoryBestPrices).toEqual([]);
    expect(vi.mocked(savePricingSnapshot)).not.toHaveBeenCalled();
  });

  it("persists a pricing snapshot with the granularity tag (Stagehand fallback path)", async () => {
    vi.mocked(fetchSailingPricingViaGraphql).mockResolvedValue(null);
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    await getSuperCategoryPricing(fakeRequest());
    expect(vi.mocked(savePricingSnapshot)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(savePricingSnapshot).mock.calls[0];
    expect(call?.[0]?.granularity).toBe("super-category");
  });

  it("second identical super-category request hits the cache (no duplicate producer run)", async () => {
    vi.mocked(fetchSailingPricingViaGraphql).mockResolvedValue(null);
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const req = fakeRequest();
    const first = await getSuperCategoryPricing(req);
    const second = await getSuperCategoryPricing(req);
    expect(first).toEqual(second);
    // Producer only ran once; the second call was served from the
    // LRU cache that getOrCreateInFlight writes on resolve.
    expect(vi.mocked(runWithSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePricingSnapshot)).toHaveBeenCalledTimes(1);
  });

  it("concurrent identical super-category requests collapse to a single producer", async () => {
    vi.mocked(fetchSailingPricingViaGraphql).mockImplementation(async () => {
      // Tick so concurrent callers land on the same in-flight entry.
      await new Promise((r) => setImmediate(r));
      return null;
    });
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const req = fakeRequest();
    const [a, b, c] = await Promise.all([
      getSuperCategoryPricing(req),
      getSuperCategoryPricing(req),
      getSuperCategoryPricing(req),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    // 3 concurrent requests → 1 Stagehand session + 1 snapshot write.
    expect(vi.mocked(runWithSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePricingSnapshot)).toHaveBeenCalledTimes(1);
  });
});
