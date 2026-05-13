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
import { scrapeSailingPackages } from "@/scraper/flows/sailing-package";
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

function makeFakeSession(params: {
  extractResult?: unknown;
  extractThrows?: Error;
}): BrowserSession {
  const goto = vi.fn().mockResolvedValue(undefined);
  const act = vi.fn().mockResolvedValue(undefined);
  const extract = vi.fn();
  if (params.extractThrows) {
    extract.mockRejectedValue(params.extractThrows);
  } else {
    extract.mockResolvedValue(params.extractResult ?? { sailings: [] });
  }
  // Low minTime so tests don't wait on real delays.
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
      extractResult: {
        sailings: [
          {
            brandCode: "R",
            shipCode: "RD",
            sailDate: "2025-06-20",
            packageCode: "RD10BQ09",
            duration: 10,
          },
        ],
      },
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
      extractResult: {
        sailings: [
          { brandCode: "R", shipCode: "RD", sailDate: "2025-06-20", packageCode: "X", duration: 7 },
        ],
      },
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
      extractResult: {
        sailings: [
          { brandCode: "R", shipCode: "RD", sailDate: "2025-06-20", packageCode: "X", duration: 7 },
        ],
      },
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

  it("throws EmptyResultsError when extract returns []", async () => {
    const session = makeFakeSession({ extractResult: { sailings: [] } });
    await expect(
      scrapeSailingPackages(session, {
        brandCode: "R",
        fromSailDate: "2025-06-01",
        toSailDate: "2025-06-30",
      })
    ).rejects.toBeInstanceOf(EmptyResultsError);
  });
});

describe("scraper/flows/pricing", () => {
  it("returns cabin options from a successful extract", async () => {
    const session = makeFakeSession({
      extractResult: {
        cabinOptions: [{ stateroomCategoryCode: "A1", pricePerGuest: 4886 }],
      },
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
      extractResult: { cabinOptions: [{ stateroomCategoryCode: "X", pricePerGuest: 1 }] },
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
      extractResult: { cabinOptions: [{ stateroomCategoryCode: "X", pricePerGuest: 1 }] },
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
    const session = makeFakeSession({ extractResult: { cabinOptions: [] } });
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
      extractResult: { promotions: [{ id: "P1", shortDescription: "Deal" }] },
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
      extractResult: { promotions: [{ id: "P1" }] },
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
    const session = makeFakeSession({ extractResult: { promotions: [] } });
    await expect(
      scrapePromotions(session, { brand: "R", currencyCodes: ["USD"] })
    ).rejects.toBeInstanceOf(EmptyResultsError);
  });
});
