import { beforeEach, describe, expect, it, vi } from "vitest";

import { promotionDetailsResponseSchema } from "@/api/schemas/promotion-details";
import { clearResponseCache } from "@/cache/response-cache";
import { runWithSession } from "@/scraper/pool";
import { getPromotionDetails } from "@/services/promotions";
import { savePromotionSnapshot } from "@/snapshots/store";

vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn(),
}));

vi.mock("@/snapshots/store", () => ({
  savePromotionSnapshot: vi.fn(),
}));

describe("services/promotions", () => {
  beforeEach(() => {
    clearResponseCache();
    vi.mocked(runWithSession).mockReset();
    vi.mocked(savePromotionSnapshot).mockReset();
  });

  it("client-scoped request returns a VPS-parseable envelope", async () => {
    vi.mocked(runWithSession).mockResolvedValue([
      {
        id: "P1",
        shortDescription: "Early booking",
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        typeCode: "D",
      },
    ]);
    const response = await getPromotionDetails({
      brand: "R",
      client: { agencyId: "A1", currencyCodes: ["USD"] },
    });
    const parsed = promotionDetailsResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    expect(response.promotions).toHaveLength(1);
    expect(response.promotions[0]?.startDateTime).toBe(20250101000000);
    expect(response.promotions[0]?.endDateTime).toBe(20251231000000);
  });

  it("market-scoped request derives the market key for snapshots", async () => {
    vi.mocked(runWithSession).mockResolvedValue([{ id: "P1", shortDescription: "Summer" }]);
    await getPromotionDetails({
      brand: "C",
      market: { officeCode: "MIA", countryCode: "USA", currencyCodes: ["USD"] },
    });
    expect(vi.mocked(savePromotionSnapshot)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(savePromotionSnapshot).mock.calls[0];
    expect(call?.[0]?.marketKey).toBe("MIA|USA|USD");
  });

  it("falls back to the open-ended endDateTime sentinel when undefined", async () => {
    vi.mocked(runWithSession).mockResolvedValue([{ id: "P1" }]);
    const response = await getPromotionDetails({
      brand: "R",
      client: { agencyId: "A1", currencyCodes: ["USD"] },
    });
    expect(response.promotions[0]?.endDateTime).toBe(99991231235959);
  });
});
