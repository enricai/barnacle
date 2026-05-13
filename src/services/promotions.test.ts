import { beforeEach, describe, expect, it, vi } from "vitest";

import { promotionDetailsResponseSchema } from "@/api/schemas/promotion-details";
import { clearResponseCache } from "@/cache/response-cache";
import { EmptyResultsError } from "@/scraper/errors";
import { scrapePromotions } from "@/scraper/flows/promotions";
import { runWithSession } from "@/scraper/pool";
import { getPromotionDetails } from "@/services/promotions";
import { savePromotionSnapshot } from "@/snapshots/store";

vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn(),
}));

vi.mock("@/scraper/flows/promotions", () => ({
  scrapePromotions: vi.fn(),
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

  it("marketKey is stable under currencyCodes reorder (set-semantic)", async () => {
    // Two callers hitting the same RC market with different currency
    // orderings must persist to the same snapshot row, not duplicate it.
    // Clear the response cache between calls so both requests hit the
    // snapshot path (the cache itself sorts primitive arrays, so without
    // this the second call would short-circuit — correct cache behavior
    // but not what we're testing here).
    vi.mocked(runWithSession).mockResolvedValue([{ id: "P1" }]);
    await getPromotionDetails({
      brand: "R",
      market: { officeCode: "MIA", countryCode: "USA", currencyCodes: ["USD", "CAD"] },
    });
    clearResponseCache();
    await getPromotionDetails({
      brand: "R",
      market: { officeCode: "MIA", countryCode: "USA", currencyCodes: ["CAD", "USD"] },
    });
    const calls = vi.mocked(savePromotionSnapshot).mock.calls;
    expect(calls).toHaveLength(2);
    const keys = calls.map((c) => c[0]?.marketKey);
    expect(keys[0]).toBe(keys[1]);
    // Sorted alphabetically — CAD before USD.
    expect(keys[0]).toBe("MIA|USA|CAD,USD");
  });

  it("EmptyResultsError yields an empty promotions array (Task 10)", async () => {
    vi.mocked(runWithSession).mockRejectedValue(new EmptyResultsError());
    const response = await getPromotionDetails({
      brand: "R",
      client: { agencyId: "A1", currencyCodes: ["USD"] },
    });
    expect(response.status.httpStatus).toBe("OK");
    expect(response.promotions).toEqual([]);
  });

  it("falls back to the open-ended endDateTime sentinel when undefined", async () => {
    vi.mocked(runWithSession).mockResolvedValue([{ id: "P1" }]);
    const response = await getPromotionDetails({
      brand: "R",
      client: { agencyId: "A1", currencyCodes: ["USD"] },
    });
    expect(response.promotions[0]?.endDateTime).toBe(99991231235959);
  });

  it("rethrows non-EmptyResultsError failures (captcha, selector, etc.)", async () => {
    // Anything other than EmptyResultsError should surface to the
    // caller so the error-handler plugin can wrap it in a 500 envelope.
    // A silent catch here would hide real outages as empty envelopes.
    vi.mocked(runWithSession).mockRejectedValue(new Error("captcha encountered"));
    await expect(
      getPromotionDetails({
        brand: "R",
        client: { agencyId: "A1", currencyCodes: ["USD"] },
      })
    ).rejects.toThrow(/captcha/);
  });

  it("second identical request hits the cache (no duplicate producer run)", async () => {
    vi.mocked(runWithSession).mockResolvedValue([{ id: "P1", shortDescription: "promo" }]);
    const a = await getPromotionDetails({
      brand: "R",
      client: { agencyId: "A1", currencyCodes: ["USD"] },
    });
    const b = await getPromotionDetails({
      brand: "R",
      client: { agencyId: "A1", currencyCodes: ["USD"] },
    });
    expect(a).toEqual(b);
    expect(vi.mocked(runWithSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePromotionSnapshot)).toHaveBeenCalledTimes(1);
  });

  it("passes brand + currencies + marketCountryCode into scrapePromotions", async () => {
    // Covers the inner callback — until now, runWithSession mocks bypassed
    // the scrapePromotions invocation entirely, so a bug in the input
    // mapping would slip through. Drive the callback by making
    // runWithSession actually invoke it.
    vi.mocked(runWithSession).mockImplementation(async (task) =>
      task({
        sessionId: "test",
        stagehand: {} as never,
        limiter: {} as never,
        close: async () => undefined,
      })
    );
    vi.mocked(scrapePromotions).mockResolvedValue([{ id: "P1", shortDescription: "promo" }]);
    await getPromotionDetails({
      brand: "C",
      market: { officeCode: "MIA", countryCode: "USA", currencyCodes: ["EUR", "GBP"] },
    });
    expect(vi.mocked(scrapePromotions)).toHaveBeenCalledOnce();
    const [, input] = vi.mocked(scrapePromotions).mock.calls[0] ?? [];
    expect(input?.brand).toBe("C");
    expect(input?.currencyCodes).toEqual(["EUR", "GBP"]);
    expect(input?.marketCountryCode).toBe("USA");
  });

  it("concurrent identical requests collapse to a single producer run", async () => {
    vi.mocked(runWithSession).mockImplementation(async () => {
      // Tick so concurrent callers land on the same in-flight entry.
      await new Promise((r) => setImmediate(r));
      return [{ id: "P1", shortDescription: "promo" }];
    });
    const [a, b, c] = await Promise.all([
      getPromotionDetails({
        brand: "R",
        client: { agencyId: "A1", currencyCodes: ["USD"] },
      }),
      getPromotionDetails({
        brand: "R",
        client: { agencyId: "A1", currencyCodes: ["USD"] },
      }),
      getPromotionDetails({
        brand: "R",
        client: { agencyId: "A1", currencyCodes: ["USD"] },
      }),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(vi.mocked(runWithSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePromotionSnapshot)).toHaveBeenCalledTimes(1);
  });
});
