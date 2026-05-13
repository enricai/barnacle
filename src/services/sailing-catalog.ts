import { parseISO } from "date-fns";

import { successEnvelope } from "@/api/helpers/envelope";
import type { SailingPackageRequest, SailingPackageResponse } from "@/api/schemas/sailing-package";
import type { SailingPackageChangesResponse } from "@/api/schemas/sailing-package-changes";
import { getCachedResponse, setCachedResponse } from "@/cache/response-cache";
import { EmptyResultsError } from "@/scraper/errors";
import { scrapeSailingPackages } from "@/scraper/flows/sailing-package";
import { runWithSession } from "@/scraper/pool";
import { findSailingKeysChangedSince, saveSailingSnapshot } from "@/snapshots/store";

const ENDPOINT = "/v1/catalog/sailing-package";

/**
 * Fetches sailings for the given request. Hot-path goes straight through
 * the response cache; cold-path drives the scraper pool, persists a
 * snapshot per sailing (for the delta endpoint), and shapes the result
 * into VPS's SailingPackageResponse.
 */
export async function getSailingPackages(
  request: SailingPackageRequest
): Promise<SailingPackageResponse> {
  const cached = getCachedResponse<SailingPackageResponse>(ENDPOINT, request);
  if (cached.value) return cached.value;

  // Task 10: "empty results (return empty array, not 500)". Catch the
  // EmptyResultsError sentinel the scraper throws and convert into an
  // empty-packages VPS envelope; everything else propagates.
  const sailings = await runWithSession((session) => scrapeSailingPackages(session, request)).catch(
    (err) => {
      if (err instanceof EmptyResultsError) return [] as const;
      throw err;
    }
  );

  for (const s of sailings) {
    await saveSailingSnapshot(
      {
        brandCode: s.brandCode,
        shipCode: s.shipCode,
        sailDate: parseISO(s.sailDate),
        packageCode: s.packageCode,
      },
      s
    );
  }

  const response = successEnvelope({
    sailingPackages: sailings,
  }) as SailingPackageResponse;

  setCachedResponse(cached.key, response);
  return response;
}

/**
 * Returns sailing keys that have changed since `fromDateTime`. Uses the
 * SailingSnapshot table — the daily refresh worker populates it, and the
 * delta endpoint reads against its own cutoff.
 */
export async function getSailingPackageChanges(
  fromDateTime: string
): Promise<SailingPackageChangesResponse> {
  const since = parseISO(fromDateTime);
  const rows = await findSailingKeysChangedSince(since);
  const keys = rows.map((r) => ({
    shipCode: r.shipCode,
    sailDate: Number.parseInt(r.sailDate.toISOString().slice(0, 10).replace(/-/g, ""), 10),
    packageCode: r.packageCode,
  }));
  return successEnvelope({
    keys,
    dateTimeRange: {
      fromDateTime,
      toDateTime: new Date().toISOString(),
    },
  }) as SailingPackageChangesResponse;
}
