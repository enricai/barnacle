import { beforeEach, describe, expect, it, vi } from "vitest";

import { categoryPricingResponseSchema } from "@/api/schemas/category-pricing";
import { groupPricingResponseSchema } from "@/api/schemas/group-pricing";
import { superCategoryPricingResponseSchema } from "@/api/schemas/super-category-pricing";
import { clearResponseCache } from "@/cache/response-cache";
import { EmptyResultsError } from "@/scraper/errors";
import { runWithSession } from "@/scraper/pool";
import { getCategoryPricing, getGroupPricing, getSuperCategoryPricing } from "@/services/pricing";
import { savePricingSnapshot } from "@/snapshots/store";

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
    vi.mocked(runWithSession).mockReset();
    vi.mocked(savePricingSnapshot).mockReset();
  });

  it("getSuperCategoryPricing groups cabins by super-category and round-trips", async () => {
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const response = await getSuperCategoryPricing(fakeRequest());
    expect(superCategoryPricingResponseSchema.safeParse(response).success).toBe(true);
    const entries = response.promotionBestPrices[0]?.superCategoryBestPrices ?? [];
    const codes = entries.map((e) => e.superCategoryCode).sort();
    expect(codes).toEqual(["B", "D"]);
  });

  it("getCategoryPricing emits one row per stateroom category and round-trips", async () => {
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const response = await getCategoryPricing(fakeRequest());
    expect(categoryPricingResponseSchema.safeParse(response).success).toBe(true);
    expect(response.categoryBestPrices).toHaveLength(2);
  });

  it("getGroupPricing wraps category rows in a synthetic group shell and round-trips", async () => {
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    const response = await getGroupPricing(fakeRequest());
    expect(groupPricingResponseSchema.safeParse(response).success).toBe(true);
    expect(response.groupBestPrices).toHaveLength(1);
    expect(response.groupBestPrices[0]?.groupId).toBe("PUBLIC");
    expect(response.groupBestPrices[0]?.allocatedCategoryBestPrices).toHaveLength(2);
  });

  it("EmptyResultsError from scraper yields empty pricing response (Task 10)", async () => {
    vi.mocked(runWithSession).mockRejectedValue(new EmptyResultsError());
    const response = await getSuperCategoryPricing(fakeRequest());
    expect(response.status.httpStatus).toBe("OK");
    expect(response.promotionBestPrices).toHaveLength(1);
    expect(response.promotionBestPrices[0]?.superCategoryBestPrices).toEqual([]);
    expect(vi.mocked(savePricingSnapshot)).not.toHaveBeenCalled();
  });

  it("persists a pricing snapshot with the granularity tag", async () => {
    vi.mocked(runWithSession).mockResolvedValue(fakeCabins());
    await getSuperCategoryPricing(fakeRequest());
    expect(vi.mocked(savePricingSnapshot)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(savePricingSnapshot).mock.calls[0];
    expect(call?.[0]?.granularity).toBe("super-category");
  });
});
