import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Snapshot store's delta query is the hot path for the three price-
 * changes endpoints. The naive "any row newer than cutoff" logic used
 * to over-report — every hourly refresh that re-observed an unchanged
 * sailing looked like drift. These tests pin the real behaviour: a
 * key appears in the delta IFF its latest post-cutoff payload differs
 * from its last pre-cutoff payload (or no pre-cutoff payload exists).
 */

const prismaMocks = vi.hoisted(() => ({
  sailingSnapshot: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  pricingSnapshot: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  promotionSnapshot: {
    create: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: prismaMocks,
}));

import {
  findPricingKeysChangedSince,
  findSailingKeysChangedSince,
  savePricingSnapshot,
  savePromotionSnapshot,
  saveSailingSnapshot,
} from "@/snapshots/store";

const SINCE = new Date("2026-05-12T00:00:00Z");

function sailingKey(overrides: Partial<{ shipCode: string; packageCode: string }> = {}) {
  return {
    shipCode: overrides.shipCode ?? "WN",
    sailDate: new Date("2026-06-07T00:00:00Z"),
    packageCode: overrides.packageCode ?? "WN07C111",
  };
}

function pricingKey(overrides: Partial<{ currencyCode: string }> = {}) {
  return {
    shipCode: "WN",
    sailDate: new Date("2026-06-07T00:00:00Z"),
    packageCode: "WN07C111",
    currencyCode: overrides.currencyCode ?? "USD",
    occupancy: 2,
    bookingTypeCode: "I",
  };
}

describe("snapshots/store findSailingKeysChangedSince", () => {
  beforeEach(() => {
    prismaMocks.sailingSnapshot.findMany.mockReset();
    prismaMocks.sailingSnapshot.findFirst.mockReset();
  });

  it("includes a key when the latest post-since payload differs from the prior one", async () => {
    prismaMocks.sailingSnapshot.findMany.mockResolvedValueOnce([sailingKey()]);
    prismaMocks.sailingSnapshot.findFirst
      .mockResolvedValueOnce({ payload: { price: 200 } })
      .mockResolvedValueOnce({ payload: { price: 150 } });
    const result = await findSailingKeysChangedSince(SINCE);
    expect(result).toHaveLength(1);
  });

  it("skips a key when the latest post-since payload matches the prior one", async () => {
    prismaMocks.sailingSnapshot.findMany.mockResolvedValueOnce([sailingKey()]);
    prismaMocks.sailingSnapshot.findFirst
      .mockResolvedValueOnce({ payload: { price: 150, cabins: ["a", "b"] } })
      .mockResolvedValueOnce({ payload: { cabins: ["a", "b"], price: 150 } });
    const result = await findSailingKeysChangedSince(SINCE);
    expect(result).toEqual([]);
  });

  it("includes a key with post-since capture but no prior one (first observation)", async () => {
    prismaMocks.sailingSnapshot.findMany.mockResolvedValueOnce([sailingKey()]);
    prismaMocks.sailingSnapshot.findFirst
      .mockResolvedValueOnce({ payload: { price: 150 } })
      .mockResolvedValueOnce(null);
    const result = await findSailingKeysChangedSince(SINCE);
    expect(result).toHaveLength(1);
  });

  it("skips a key whose candidate row exists but has no latest payload (race condition)", async () => {
    prismaMocks.sailingSnapshot.findMany.mockResolvedValueOnce([sailingKey()]);
    prismaMocks.sailingSnapshot.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ payload: { price: 150 } });
    const result = await findSailingKeysChangedSince(SINCE);
    expect(result).toEqual([]);
  });

  it("returns an empty array when no candidates exist", async () => {
    prismaMocks.sailingSnapshot.findMany.mockResolvedValueOnce([]);
    const result = await findSailingKeysChangedSince(SINCE);
    expect(result).toEqual([]);
    expect(prismaMocks.sailingSnapshot.findFirst).not.toHaveBeenCalled();
  });
});

describe("snapshots/store findPricingKeysChangedSince", () => {
  beforeEach(() => {
    prismaMocks.pricingSnapshot.findMany.mockReset();
    prismaMocks.pricingSnapshot.findFirst.mockReset();
  });

  it("scopes the candidate query by granularity", async () => {
    prismaMocks.pricingSnapshot.findMany.mockResolvedValueOnce([]);
    await findPricingKeysChangedSince(SINCE, "super-category");
    const call = prismaMocks.pricingSnapshot.findMany.mock.calls[0]?.[0] as {
      where: { granularity: string };
    };
    expect(call.where.granularity).toBe("super-category");
  });

  it("emits a key with differing payloads", async () => {
    prismaMocks.pricingSnapshot.findMany.mockResolvedValueOnce([pricingKey()]);
    prismaMocks.pricingSnapshot.findFirst
      .mockResolvedValueOnce({ pricePayload: [{ code: "I", price: 550 }] })
      .mockResolvedValueOnce({ pricePayload: [{ code: "I", price: 500 }] });
    const result = await findPricingKeysChangedSince(SINCE, "super-category");
    expect(result).toHaveLength(1);
    expect(result[0]?.currencyCode).toBe("USD");
  });

  it("filters out keys whose latest payload is identical (order-insensitive)", async () => {
    prismaMocks.pricingSnapshot.findMany.mockResolvedValueOnce([pricingKey()]);
    prismaMocks.pricingSnapshot.findFirst
      .mockResolvedValueOnce({ pricePayload: { a: 1, b: 2 } })
      .mockResolvedValueOnce({ pricePayload: { b: 2, a: 1 } });
    const result = await findPricingKeysChangedSince(SINCE, "super-category");
    expect(result).toEqual([]);
  });

  it("emits a first-observation key with no prior snapshot", async () => {
    prismaMocks.pricingSnapshot.findMany.mockResolvedValueOnce([pricingKey()]);
    prismaMocks.pricingSnapshot.findFirst
      .mockResolvedValueOnce({ pricePayload: { price: 500 } })
      .mockResolvedValueOnce(null);
    const result = await findPricingKeysChangedSince(SINCE, "super-category");
    expect(result).toHaveLength(1);
  });

  it("distinct-on includes bookingTypeCode so I+G deltas don't collapse", async () => {
    // Prisma's `distinct` keeps one arbitrary row per distinct tuple.
    // Without bookingTypeCode in the distinct list, a (ship/date/
    // package/currency/occupancy) key with deltas on both "I" and "G"
    // would emit only one booking type, and the other's change would
    // silently disappear from the response. Pin the WHERE + distinct
    // shape so a future "simplify" refactor can't regress this.
    prismaMocks.pricingSnapshot.findMany.mockResolvedValueOnce([]);
    await findPricingKeysChangedSince(SINCE, "category");
    const call = prismaMocks.pricingSnapshot.findMany.mock.calls[0]?.[0] as {
      distinct: string[];
    };
    expect(call.distinct).toContain("bookingTypeCode");
    expect(call.distinct).toContain("occupancy");
    expect(call.distinct).toContain("currencyCode");
  });
});

describe("snapshots/store write paths", () => {
  beforeEach(() => {
    prismaMocks.sailingSnapshot.create.mockReset();
    prismaMocks.pricingSnapshot.create.mockReset();
    prismaMocks.promotionSnapshot.create.mockReset();
  });

  it("saveSailingSnapshot passes every key field + payload to prisma.create", async () => {
    prismaMocks.sailingSnapshot.create.mockResolvedValue({});
    await saveSailingSnapshot(
      {
        brandCode: "R",
        shipCode: "WN",
        sailDate: new Date("2026-06-07T00:00:00Z"),
        packageCode: "WN07C111",
      },
      { price: 599 }
    );
    const args = prismaMocks.sailingSnapshot.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(args.data).toEqual({
      brandCode: "R",
      shipCode: "WN",
      sailDate: new Date("2026-06-07T00:00:00Z"),
      packageCode: "WN07C111",
      payload: { price: 599 },
    });
  });

  it("savePricingSnapshot includes granularity + all pricing-key fields", async () => {
    prismaMocks.pricingSnapshot.create.mockResolvedValue({});
    await savePricingSnapshot(
      {
        brandCode: "R",
        shipCode: "WN",
        sailDate: new Date("2026-06-07T00:00:00Z"),
        packageCode: "WN07C111",
        currencyCode: "USD",
        occupancy: 2,
        bookingTypeCode: "I",
        granularity: "super-category",
      },
      [{ code: "I", price: 599 }]
    );
    const args = prismaMocks.pricingSnapshot.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(args.data.granularity).toBe("super-category");
    expect(args.data.currencyCode).toBe("USD");
    expect(args.data.occupancy).toBe(2);
    expect(args.data.bookingTypeCode).toBe("I");
    expect(args.data.pricePayload).toEqual([{ code: "I", price: 599 }]);
  });

  it("savePromotionSnapshot nullifies missing agencyId / marketKey instead of leaving them undefined", async () => {
    prismaMocks.promotionSnapshot.create.mockResolvedValue({});
    await savePromotionSnapshot({ brand: "R" }, [{ id: "p-1" }]);
    const args = prismaMocks.promotionSnapshot.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    // Prisma rejects `undefined` for nullable columns; the save helpers
    // coerce missing inputs to null so the create call is well-formed.
    expect(args.data.agencyId).toBeNull();
    expect(args.data.marketKey).toBeNull();
    expect(args.data.brand).toBe("R");
    expect(args.data.payload).toEqual([{ id: "p-1" }]);
  });

  it("savePromotionSnapshot preserves agencyId + marketKey when supplied", async () => {
    prismaMocks.promotionSnapshot.create.mockResolvedValue({});
    await savePromotionSnapshot({ brand: "R", agencyId: "A1", marketKey: "MIA|USA|USD" }, []);
    const args = prismaMocks.promotionSnapshot.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(args.data.agencyId).toBe("A1");
    expect(args.data.marketKey).toBe("MIA|USA|USD");
  });
});
