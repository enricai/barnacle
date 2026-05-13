import { beforeEach, describe, expect, it, vi } from "vitest";

import { sailingPackageResponseSchema } from "@/api/schemas/sailing-package";
import { clearResponseCache } from "@/cache/response-cache";
import { EmptyResultsError } from "@/scraper/errors";
import { fetchSailingPackagesViaGraphql } from "@/scraper/flows/graphql-catalog";
import { GraphQlRequestError } from "@/scraper/graphql";
import { runWithSession } from "@/scraper/pool";
import { getSailingPackageChanges, getSailingPackages } from "@/services/sailing-catalog";
import { findSailingKeysChangedSince, saveSailingSnapshot } from "@/snapshots/store";

// Hoisted logger stub so the module-level getLogger in sailing-catalog.ts
// picks it up. "falling back to Stagehand" is a major cost event ops
// need to alert on (Steel session minutes spike), so we pin it here.
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

/**
 * The service layer pulls the GraphQL catalog, the scraper pool, and the
 * snapshot store in at module load time. Mocking those before importing
 * the service keeps every test hermetic — no browser, no DB, no network.
 */
vi.mock("@/scraper/flows/graphql-catalog", () => ({
  fetchSailingPackagesViaGraphql: vi.fn(),
}));

vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn(),
}));

vi.mock("@/snapshots/store", () => ({
  saveSailingSnapshot: vi.fn(),
  findSailingKeysChangedSince: vi.fn(),
}));

describe("services/sailing-catalog", () => {
  beforeEach(() => {
    clearResponseCache();
    vi.mocked(fetchSailingPackagesViaGraphql).mockReset();
    vi.mocked(runWithSession).mockReset();
    vi.mocked(saveSailingSnapshot).mockReset();
    vi.mocked(findSailingKeysChangedSince).mockReset();
  });

  it("getSailingPackages returns a VPS envelope that round-trips through the schema", async () => {
    vi.mocked(fetchSailingPackagesViaGraphql).mockResolvedValue([
      {
        brandCode: "R",
        shipCode: "RD",
        shipName: "RADIANCE OF THE SEAS",
        sailDate: "2025-06-20",
        packageCode: "RD10BQ09",
        duration: 10,
        packageDescription: "10nt ALASKA",
      },
    ]);

    const response = await getSailingPackages({
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
      includeTourPackages: false,
    });

    const parsed = sailingPackageResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    expect(response.status.httpStatus).toBe("OK");
    expect(response.sailingPackages).toHaveLength(1);
    expect(vi.mocked(saveSailingSnapshot)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runWithSession)).not.toHaveBeenCalled();
  });

  it("second identical request hits the response cache and skips the scraper", async () => {
    vi.mocked(fetchSailingPackagesViaGraphql).mockResolvedValue([
      {
        brandCode: "R",
        shipCode: "RD",
        sailDate: "2025-06-20",
        packageCode: "RD10BQ09",
        duration: 10,
      },
    ]);
    const request = {
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
      includeTourPackages: false,
    };
    await getSailingPackages(request);
    await getSailingPackages(request);
    expect(vi.mocked(fetchSailingPackagesViaGraphql)).toHaveBeenCalledTimes(1);
  });

  it("GraphQL failure falls back to the Stagehand flow", async () => {
    vi.mocked(fetchSailingPackagesViaGraphql).mockRejectedValue(
      new GraphQlRequestError("cruiseSearch_Cruises returned HTTP 500", 500)
    );
    vi.mocked(runWithSession).mockResolvedValue([
      {
        brandCode: "R",
        shipCode: "RD",
        sailDate: "2025-06-20",
        packageCode: "RD10BQ09",
        duration: 10,
      },
    ]);
    const response = await getSailingPackages({
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
      includeTourPackages: false,
    });
    expect(response.status.httpStatus).toBe("OK");
    expect(response.sailingPackages).toHaveLength(1);
    expect(vi.mocked(runWithSession)).toHaveBeenCalledTimes(1);
  });

  it("EmptyResultsError from the Stagehand fallback becomes an empty array (Task 10)", async () => {
    vi.mocked(fetchSailingPackagesViaGraphql).mockRejectedValue(
      new GraphQlRequestError("cruiseSearch_Cruises returned HTTP 500", 500)
    );
    vi.mocked(runWithSession).mockRejectedValue(new EmptyResultsError());
    const response = await getSailingPackages({
      brandCode: "R",
      fromSailDate: "2099-01-01",
      toSailDate: "2099-01-02",
      includeTourPackages: false,
    });
    expect(response.status.httpStatus).toBe("OK");
    expect(response.sailingPackages).toEqual([]);
    expect(vi.mocked(saveSailingSnapshot)).not.toHaveBeenCalled();
  });

  it("non-EmptyResults failure from the Stagehand fallback propagates to the caller", async () => {
    // Covers the `throw fallbackErr` branch — if both paths fail, the
    // caller must see the Stagehand error (selector failure, timeout,
    // captcha) so the error-handler can emit a proper 500 envelope,
    // not a misleading empty-results 200.
    vi.mocked(fetchSailingPackagesViaGraphql).mockRejectedValue(
      new GraphQlRequestError("cruiseSearch_Cruises returned HTTP 500", 500)
    );
    vi.mocked(runWithSession).mockRejectedValue(new Error("selector not found after 3 retries"));
    await expect(
      getSailingPackages({
        brandCode: "R",
        fromSailDate: "2025-06-01",
        toSailDate: "2025-06-30",
        includeTourPackages: false,
      })
    ).rejects.toThrow(/selector not found/);
  });

  it("GraphQL returning zero sailings is treated as empty without invoking Stagehand", async () => {
    vi.mocked(fetchSailingPackagesViaGraphql).mockResolvedValue([]);
    const response = await getSailingPackages({
      brandCode: "R",
      fromSailDate: "2099-01-01",
      toSailDate: "2099-01-02",
      includeTourPackages: false,
    });
    expect(response.status.httpStatus).toBe("OK");
    expect(response.sailingPackages).toEqual([]);
    expect(vi.mocked(runWithSession)).not.toHaveBeenCalled();
  });

  it("emits a warn log when GraphQL fails and the Stagehand fallback kicks in", async () => {
    loggerStub.warn.mockClear();
    vi.mocked(fetchSailingPackagesViaGraphql).mockRejectedValue(
      new GraphQlRequestError("cruiseSearch_Cruises returned HTTP 503", 503)
    );
    vi.mocked(runWithSession).mockResolvedValue([]);
    await getSailingPackages({
      brandCode: "R",
      fromSailDate: "2025-06-01",
      toSailDate: "2025-06-30",
      includeTourPackages: false,
    });
    expect(loggerStub.warn).toHaveBeenCalledOnce();
    expect(loggerStub.warn.mock.calls[0]?.[0]).toMatch(/falling back to Stagehand/);
  });

  it("emits an info log when GraphQL returns zero sailings (no fallback)", async () => {
    loggerStub.info.mockClear();
    vi.mocked(fetchSailingPackagesViaGraphql).mockResolvedValue([]);
    await getSailingPackages({
      brandCode: "R",
      fromSailDate: "2099-01-01",
      toSailDate: "2099-01-02",
      includeTourPackages: false,
    });
    const zeroSailingsLog = loggerStub.info.mock.calls
      .map((c) => c[0] as string)
      .find((m) => /graphql catalog returned 0 sailings/.test(m));
    expect(zeroSailingsLog).toBeDefined();
  });

  it("saveSailingSnapshot anchors sailDate to UTC midnight (round-trip stable east of UTC)", async () => {
    // Regression guard for the TZ-sensitivity bug: writes used to go
    // through parseISO which anchors to LOCAL midnight. Reading back
    // with toISOString().slice(0,10) then slipped a day on servers
    // east of UTC. The fix anchors writes to UTC midnight so the
    // slice(0,10) always yields the original calendar day.
    vi.mocked(fetchSailingPackagesViaGraphql).mockResolvedValue([
      {
        brandCode: "R",
        shipCode: "WN",
        sailDate: "2026-06-20",
        packageCode: "WN04",
        duration: 4,
      },
    ]);
    await getSailingPackages({
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
      includeTourPackages: false,
    });
    const call = vi.mocked(saveSailingSnapshot).mock.calls[0];
    const storedDate = call?.[0]?.sailDate;
    // UTC midnight: time-of-day is 00:00:00Z regardless of process TZ.
    expect(storedDate?.toISOString()).toBe("2026-06-20T00:00:00.000Z");
  });

  it("passes the Task 8 filter set through to the GraphQL catalog flow verbatim", async () => {
    // Pins the service layer's responsibility: accept every field the
    // request schema allows and hand them to fetchSailingPackagesViaGraphql
    // without mapping or loss. `pickMostSelectiveFilter` + client-side
    // drop logic inside the flow is tested separately in
    // graphql-catalog.test.ts; here we only verify the plumbing.
    vi.mocked(fetchSailingPackagesViaGraphql).mockResolvedValue([]);
    await getSailingPackages({
      brandCode: "R",
      fromSailDate: "2026-06-01",
      toSailDate: "2026-06-30",
      shipCodes: ["WN"],
      destinations: ["CARIB"],
      departurePorts: ["MIA"],
      cruiseLengthRange: { min: 5, max: 7 },
      guestCount: 2,
      cabinType: "BALCONY",
      includeTourPackages: false,
    });
    const call = vi.mocked(fetchSailingPackagesViaGraphql).mock.calls[0];
    const input = call?.[0];
    expect(input?.shipCodes).toEqual(["WN"]);
    expect(input?.destinations).toEqual(["CARIB"]);
    expect(input?.departurePorts).toEqual(["MIA"]);
    expect(input?.cruiseLengthRange).toEqual({ min: 5, max: 7 });
    expect(input?.guestCount).toBe(2);
    expect(input?.cabinType).toBe("BALCONY");
  });

  it("getSailingPackageChanges projects snapshot rows into VPS keys", async () => {
    vi.mocked(findSailingKeysChangedSince).mockResolvedValue([
      { shipCode: "XO", sailDate: new Date("2023-06-03"), packageCode: "XO10G041" },
      { shipCode: "XP", sailDate: new Date("2023-06-03"), packageCode: "XP10G043" },
    ]);
    const response = await getSailingPackageChanges("2023-06-01T00:00:00Z");
    expect(response.status.httpStatus).toBe("OK");
    expect(response.keys).toHaveLength(2);
    const first = response.keys[0];
    expect(first?.shipCode).toBe("XO");
    expect(first?.sailDate).toBe(20230603);
    expect(response.dateTimeRange?.fromDateTime).toBe("2023-06-01T00:00:00Z");
  });
});
