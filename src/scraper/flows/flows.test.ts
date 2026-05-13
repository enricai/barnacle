import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";

import { EmptyResultsError } from "@/scraper/errors";

// Bypass the throttle jitter/delay entirely — these tests only exercise
// the flow structure. The real throttle is covered by throttle.test.ts.
vi.mock("@/scraper/throttle", async () => {
  const actual = await vi.importActual<typeof import("@/scraper/throttle")>("@/scraper/throttle");
  return {
    ...actual,
    scheduleAction: async <T>(_limiter: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  };
});

import { scrapeSailingPricing } from "@/scraper/flows/pricing";
import { scrapePromotions } from "@/scraper/flows/promotions";
import { enrichSailingWithPricing, scrapeSailingPackages } from "@/scraper/flows/sailing-package";
import type { BrowserSession } from "@/scraper/session";

/**
 * Input-contract tests for the scraper flow modules. Task 3 in TASKS.md
 * leaves DOM selector / prompt tuning to a human who does live recon on
 * royalcaribbean.com. These tests lock the *contract* — what flows do
 * when the LLM-driven extract succeeds, what happens when it returns
 * empty, that `goto` + `act` are routed through the session limiter —
 * so prompt-tuning can proceed without regressions on the structural
 * guarantees.
 */

/**
 * Builds a fake session whose `extract()` responds according to the
 * instruction text — this makes tests robust against flows that do
 * several extract() calls in a row (sailings extract → pagination
 * probe → cabin extract → …).
 */
function makeFakeSession(params: {
  sailings?: unknown[];
  cabinOptions?: unknown[];
  promotions?: unknown[];
  paginationHasMore?: boolean;
  extractThrows?: Error;
}): BrowserSession {
  const goto = vi.fn().mockResolvedValue(undefined);
  const act = vi.fn().mockResolvedValue(undefined);
  const extract = vi.fn(async (opts: { instruction: string }) => {
    if (params.extractThrows) throw params.extractThrows;
    const i = opts.instruction.toLowerCase();
    if (i.includes("pagination") || i.includes("hasmore") || i.includes("more sailing results")) {
      return { hasMore: params.paginationHasMore ?? false, method: "none" };
    }
    if (i.includes("sailing card")) {
      return { sailings: params.sailings ?? [] };
    }
    if (i.includes("cabin") || i.includes("stateroom")) {
      return { cabinOptions: params.cabinOptions ?? [] };
    }
    if (i.includes("promotion")) {
      return { promotions: params.promotions ?? [] };
    }
    return {};
  });
  const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
  const stagehand = { page: { goto, act, extract } } as unknown as BrowserSession["stagehand"];
  return {
    stagehand,
    limiter,
    sessionId: "test",
    close: vi.fn(),
  } as unknown as BrowserSession;
}

describe("scraper/flows/sailing-package", () => {
  it("returns sailings with the request brandCode stamped in", async () => {
    const session = makeFakeSession({
      sailings: [
        {
          brandCode: "R",
          shipCode: "RD",
          sailDate: "2025-06-20",
          packageCode: "RD10BQ09",
          duration: 10,
        },
      ],
    });
    const result = await scrapeSailingPackages(session, {
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.brandCode).toBe("R");
    expect(session.stagehand.page.goto).toHaveBeenCalledTimes(1);
  });

  it("only emits a shipCodes filter act() when shipCodes is non-empty", async () => {
    const session = makeFakeSession({
      sailings: [
        { brandCode: "R", shipCode: "RD", sailDate: "2025-06-20", packageCode: "X", duration: 7 },
      ],
    });
    await scrapeSailingPackages(session, {
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
    });
    const actMock = session.stagehand.page.act as ReturnType<typeof vi.fn>;
    // Only the date-range act() should have fired.
    expect(actMock).toHaveBeenCalledTimes(1);
  });

  it("emits an additional act() when shipCodes are provided", async () => {
    const session = makeFakeSession({
      sailings: [
        { brandCode: "R", shipCode: "RD", sailDate: "2025-06-20", packageCode: "X", duration: 7 },
      ],
    });
    await scrapeSailingPackages(session, {
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
      shipCodes: ["RD", "AL"],
    });
    const actMock = session.stagehand.page.act as ReturnType<typeof vi.fn>;
    expect(actMock).toHaveBeenCalledTimes(2);
  });

  it("emits one extra act() per Task 8 filter (destinations/ports/length/cabin)", async () => {
    // The four A1-added filters each produce their own page.act() call.
    // Pins that order + count: base date-range act() + one per filter,
    // with the right keyword in each prompt so a future reorder would
    // surface here rather than silently mismapping filters.
    const session = makeFakeSession({
      sailings: [
        { brandCode: "R", shipCode: "WN", sailDate: "2026-06-07", packageCode: "X", duration: 7 },
      ],
    });
    await scrapeSailingPackages(session, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
      destinations: ["CARIB"],
      departurePorts: ["MIA"],
      cruiseLengthRange: { min: 5, max: 7 },
      cabinType: "BALCONY",
    });
    const actMock = session.stagehand.page.act as ReturnType<typeof vi.fn>;
    // 1 (date-range) + 4 (filters) + 0 (pagination, hasMore=false by default)
    expect(actMock).toHaveBeenCalledTimes(5);
    const prompts = actMock.mock.calls.map((c) => String(c[0]));
    expect(prompts.some((p) => /departure date range/.test(p))).toBe(true);
    expect(prompts.some((p) => /destination region/i.test(p))).toBe(true);
    expect(prompts.some((p) => /departure port/i.test(p))).toBe(true);
    expect(prompts.some((p) => /cruise length/i.test(p) && /5.*7/.test(p))).toBe(true);
    expect(prompts.some((p) => /stateroom type.*BALCONY/.test(p))).toBe(true);
  });

  it("requests bookingUrl in the sailing-card extract prompt (TASKS.md Task 4)", async () => {
    const session = makeFakeSession({
      sailings: [
        { brandCode: "R", shipCode: "WN", sailDate: "2026-06-07", packageCode: "X", duration: 7 },
      ],
    });
    await scrapeSailingPackages(session, {
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
    });
    const extractMock = session.stagehand.page.extract as ReturnType<typeof vi.fn>;
    const sailingCardExtract = extractMock.mock.calls.find((call) => {
      const opts = call[0] as { instruction?: string } | undefined;
      return typeof opts?.instruction === "string" && /sailing card/i.test(opts.instruction);
    });
    expect(sailingCardExtract).toBeDefined();
    const instruction = (sailingCardExtract?.[0] as { instruction: string }).instruction;
    expect(instruction).toMatch(/bookingUrl/);
  });

  it("paginates when paginationHasMore is true, up to maxPaginationPasses", async () => {
    const session = makeFakeSession({
      sailings: [
        { brandCode: "R", shipCode: "RD", sailDate: "2025-06-20", packageCode: "X", duration: 7 },
      ],
      paginationHasMore: true,
    });
    await scrapeSailingPackages(session, {
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
      maxPaginationPasses: 2,
    });
    const actMock = session.stagehand.page.act as ReturnType<typeof vi.fn>;
    const paginationActs = actMock.mock.calls.filter((call) =>
      /load more|scroll|next/.test(String(call[0]))
    );
    // 2 pagination passes → 2 act() calls to advance the list.
    expect(paginationActs).toHaveLength(2);
  });

  it("stops paginating when the probe reports hasMore=false", async () => {
    const session = makeFakeSession({
      sailings: [
        { brandCode: "R", shipCode: "RD", sailDate: "2025-06-20", packageCode: "X", duration: 7 },
      ],
      paginationHasMore: false,
    });
    await scrapeSailingPackages(session, {
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
      maxPaginationPasses: 10,
    });
    const actMock = session.stagehand.page.act as ReturnType<typeof vi.fn>;
    const paginationActs = actMock.mock.calls.filter((call) =>
      /load more|scroll|next/.test(String(call[0]))
    );
    expect(paginationActs).toHaveLength(0);
  });

  it("dedupes overlapping sailings across pagination passes by identity tuple", async () => {
    const session = makeFakeSession({
      sailings: [
        { brandCode: "R", shipCode: "RD", sailDate: "2025-06-20", packageCode: "X", duration: 7 },
      ],
      paginationHasMore: true,
    });
    const result = await scrapeSailingPackages(session, {
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
      maxPaginationPasses: 3,
    });
    // Every pass returns the same single sailing; dedup should collapse
    // to length 1 even though we looped.
    expect(result).toHaveLength(1);
  });

  it("throws EmptyResultsError when extract returns []", async () => {
    const session = makeFakeSession({ sailings: [] });
    await expect(
      scrapeSailingPackages(session, {
        brandCode: "R",
        fromSailDate: "2025-06-01",
        toSailDate: "2025-06-30",
      })
    ).rejects.toBeInstanceOf(EmptyResultsError);
  });

  it("enriches up to maxDetailEnrichments sailings with cabin pricing when enrichPricing=true", async () => {
    const session = makeFakeSession({
      sailings: [
        {
          brandCode: "R",
          shipCode: "RD",
          sailDate: "2025-06-20",
          packageCode: "X",
          duration: 7,
          bookingUrl: "https://www.royalcaribbean.com/cruise/detail/1",
        },
      ],
      cabinOptions: [{ stateroomCategoryCode: "A1", pricePerGuest: 500 }],
    });
    const result = await scrapeSailingPackages(session, {
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
      enrichPricing: true,
      maxDetailEnrichments: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.cabinOptions).toEqual([{ stateroomCategoryCode: "A1", pricePerGuest: 500 }]);
  });
});

describe("enrichSailingWithPricing", () => {
  it("returns [] when the sailing has no detail URL", async () => {
    const session = makeFakeSession({});
    const result = await enrichSailingWithPricing(session, {
      brandCode: "R",
      shipCode: "RD",
      sailDate: "2025-06-20",
      packageCode: "X",
      duration: 7,
    });
    expect(result).toEqual([]);
  });

  it("fetches cabin options from the detail URL", async () => {
    const session = makeFakeSession({
      cabinOptions: [{ stateroomCategoryCode: "B1", pricePerGuest: 700 }],
    });
    const result = await enrichSailingWithPricing(session, {
      brandCode: "R",
      shipCode: "RD",
      sailDate: "2025-06-20",
      packageCode: "X",
      duration: 7,
      bookingUrl: "https://detail/1",
    });
    expect(result).toEqual([{ stateroomCategoryCode: "B1", pricePerGuest: 700 }]);
  });

  it("returns [] and does not throw when the detail navigation errors", async () => {
    const session = makeFakeSession({
      extractThrows: new Error("timeout"),
    });
    const result = await enrichSailingWithPricing(session, {
      brandCode: "R",
      shipCode: "RD",
      sailDate: "2025-06-20",
      packageCode: "X",
      duration: 7,
      bookingUrl: "https://detail/1",
    });
    expect(result).toEqual([]);
  });
});

describe("scraper/flows/pricing", () => {
  it("returns cabin options from a successful extract", async () => {
    const session = makeFakeSession({
      cabinOptions: [{ stateroomCategoryCode: "A1", pricePerGuest: 4886 }],
    });
    const result = await scrapeSailingPricing(session, {
      brandCode: "R",
      shipCode: "EN",
      sailDate: "2024-04-20",
      packageCode: "EN07W550",
      occupancy: 2,
      currencyCode: "USD",
      bookingTypeCode: "I",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.stateroomCategoryCode).toBe("A1");
  });

  it("appends a group-context act() only when bookingTypeCode is G", async () => {
    const individual = makeFakeSession({
      cabinOptions: [{ stateroomCategoryCode: "X", pricePerGuest: 1 }],
    });
    await scrapeSailingPricing(individual, {
      brandCode: "R",
      shipCode: "EN",
      sailDate: "2024-04-20",
      packageCode: "X",
      occupancy: 2,
      currencyCode: "USD",
      bookingTypeCode: "I",
    });
    const actMockI = individual.stagehand.page.act as ReturnType<typeof vi.fn>;
    const groupInstruction = actMockI.mock.calls.some((call) =>
      String(call[0]).includes("group booking")
    );
    expect(groupInstruction).toBe(false);

    const group = makeFakeSession({
      cabinOptions: [{ stateroomCategoryCode: "X", pricePerGuest: 1 }],
    });
    await scrapeSailingPricing(group, {
      brandCode: "R",
      shipCode: "EN",
      sailDate: "2024-04-20",
      packageCode: "X",
      occupancy: 2,
      currencyCode: "USD",
      bookingTypeCode: "G",
    });
    const actMockG = group.stagehand.page.act as ReturnType<typeof vi.fn>;
    const groupInstructionG = actMockG.mock.calls.some((call) =>
      String(call[0]).includes("group booking")
    );
    expect(groupInstructionG).toBe(true);
  });

  it("throws EmptyResultsError when extract yields []", async () => {
    const session = makeFakeSession({ cabinOptions: [] });
    await expect(
      scrapeSailingPricing(session, {
        brandCode: "R",
        shipCode: "EN",
        sailDate: "2024-04-20",
        packageCode: "X",
        occupancy: 2,
        currencyCode: "USD",
        bookingTypeCode: "I",
      })
    ).rejects.toBeInstanceOf(EmptyResultsError);
  });
});

describe("scraper/flows/promotions", () => {
  it("returns the scraped promotion list", async () => {
    const session = makeFakeSession({
      promotions: [{ id: "P1", shortDescription: "Deal" }],
    });
    const result = await scrapePromotions(session, {
      brand: "R",
      currencyCodes: ["USD"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("P1");
  });

  it("drives a market-switch act() only when marketCountryCode is set", async () => {
    const session = makeFakeSession({
      promotions: [{ id: "P1" }],
    });
    await scrapePromotions(session, {
      brand: "R",
      currencyCodes: ["USD"],
      marketCountryCode: "CAN",
    });
    const actMock = session.stagehand.page.act as ReturnType<typeof vi.fn>;
    expect(actMock).toHaveBeenCalledTimes(1);
  });

  it("throws EmptyResultsError on empty extract", async () => {
    const session = makeFakeSession({ promotions: [] });
    await expect(
      scrapePromotions(session, { brand: "R", currencyCodes: ["USD"] })
    ).rejects.toBeInstanceOf(EmptyResultsError);
  });
});
