import { beforeEach, describe, expect, it, vi } from "vitest";

import { sailingPackageResponseSchema } from "@/api/schemas/sailing-package";
import { clearResponseCache } from "@/cache/response-cache";
import { runWithSession } from "@/scraper/pool";
import { getSailingPackageChanges, getSailingPackages } from "@/services/sailing-catalog";
import { findSailingKeysChangedSince, saveSailingSnapshot } from "@/snapshots/store";

/**
 * The service layer pulls the scraper pool and the snapshot store in at
 * module load time. Mocking those before importing the service keeps
 * every test hermetic — no browser, no DB.
 */
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
    vi.mocked(runWithSession).mockReset();
    vi.mocked(saveSailingSnapshot).mockReset();
    vi.mocked(findSailingKeysChangedSince).mockReset();
  });

  it("getSailingPackages returns a VPS envelope that round-trips through the schema", async () => {
    vi.mocked(runWithSession).mockResolvedValue([
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
  });

  it("second identical request hits the response cache and skips the scraper", async () => {
    vi.mocked(runWithSession).mockResolvedValue([
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
    expect(vi.mocked(runWithSession)).toHaveBeenCalledTimes(1);
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
