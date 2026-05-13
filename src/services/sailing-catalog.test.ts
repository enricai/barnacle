import { beforeEach, describe, expect, it, vi } from "vitest";

import { sailingPackageResponseSchema } from "@/api/schemas/sailing-package";
import { clearResponseCache } from "@/cache/response-cache";
import { EmptyResultsError } from "@/scraper/errors";
import { fetchSailingPackagesViaGraphql } from "@/scraper/flows/graphql-catalog";
import { GraphQlRequestError } from "@/scraper/graphql";
import { runWithSession } from "@/scraper/pool";
import { getSailingPackageChanges, getSailingPackages } from "@/services/sailing-catalog";
import { findSailingKeysChangedSince, saveSailingSnapshot } from "@/snapshots/store";

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
