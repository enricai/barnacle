import { beforeEach, describe, expect, it, vi } from "vitest";

import { priceChangeResponseSchema } from "@/api/schemas/price-changes-common";
import { getPriceChanges } from "@/services/price-changes";
import { findPricingKeysChangedSince } from "@/snapshots/store";

vi.mock("@/snapshots/store", () => ({
  findPricingKeysChangedSince: vi.fn(),
}));

describe("services/price-changes", () => {
  beforeEach(() => {
    vi.mocked(findPricingKeysChangedSince).mockReset();
  });

  it("maps snapshot rows into VPS keys with numeric sailDate", async () => {
    vi.mocked(findPricingKeysChangedSince).mockResolvedValue([
      {
        shipCode: "FL",
        sailDate: new Date("2023-06-11"),
        packageCode: "FL07G039",
        currencyCode: "USD",
        occupancy: 2,
        bookingTypeCode: "I",
      },
    ]);
    const response = await getPriceChanges("2023-06-05T00:00:00", "super-category");
    const parsed = priceChangeResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    expect(response.keys).toHaveLength(1);
    expect(response.keys[0]?.sailDate).toBe(20230611);
    expect(response.keys[0]?.currencyCode).toBe("USD");
    expect(response.keys[0]?.bookingType).toBe("I");
  });

  it("passes the granularity through to the snapshot store query", async () => {
    vi.mocked(findPricingKeysChangedSince).mockResolvedValue([]);
    await getPriceChanges("2023-06-01T00:00:00", "category");
    expect(vi.mocked(findPricingKeysChangedSince)).toHaveBeenCalledWith(
      expect.any(Date),
      "category"
    );
  });

  it("emits an empty keys array cleanly", async () => {
    vi.mocked(findPricingKeysChangedSince).mockResolvedValue([]);
    const response = await getPriceChanges("2023-06-01T00:00:00", "super-category");
    expect(response.keys).toEqual([]);
    expect(response.status.httpStatus).toBe("OK");
  });
});
