import { formatISO, parseISO } from "date-fns";

import { successEnvelope } from "@/api/helpers/envelope";
import type { SailingPackageRequest, SailingPackageResponse } from "@/api/schemas/sailing-package";
import type { SailingPackageChangesResponse } from "@/api/schemas/sailing-package-changes";
import { getCachedResponse, getOrCreateInFlight } from "@/cache/response-cache";
import { getLogger } from "@/lib/logging";
import { parseSailDateUtc, sailDateToNumeric } from "@/lib/sail-date";
import { EmptyResultsError } from "@/scraper/errors";
import { fetchSailingPackagesViaGraphql } from "@/scraper/flows/graphql-catalog";
import { type ScrapedSailing, scrapeSailingPackages } from "@/scraper/flows/sailing-package";
import { runWithSession } from "@/scraper/pool";
import { findSailingKeysChangedSince, saveSailingSnapshot } from "@/snapshots/store";

const logger = getLogger({ name: "services/sailing-catalog" });

const ENDPOINT = "/v1/catalog/sailing-package";

/**
 * Fetches sailings for the given request. Hot path goes straight
 * through the response cache. Concurrent misses for the same key
 * collapse into a single producer run via getOrCreateInFlight (no
 * upstream thundering-herd). Cold path prefers the direct-HTTP
 * GraphQL flow (zero Steel minutes, sub-second); falls back to the
 * Stagehand flow only if GraphQL errors — this preserves the
 * resilience we had when GraphQL was the fallback, not the primary.
 *
 * Per recon (docs/rc-recon.md): `cruiseSearch_Cruises` returns the
 * full catalog with per-stateroom-class pricing inline, so one call
 * covers what Stagehand did in ~20-40s of session time.
 */
export async function getSailingPackages(
  request: SailingPackageRequest
): Promise<SailingPackageResponse> {
  const cached = getCachedResponse<SailingPackageResponse>(ENDPOINT, request);
  if (cached.value) return cached.value;

  return getOrCreateInFlight<SailingPackageResponse>(cached.key, async () => {
    const sailings = await runCatalogFetchWithFallback(request);

    for (const s of sailings) {
      await saveSailingSnapshot(
        {
          brandCode: s.brandCode,
          shipCode: s.shipCode,
          sailDate: parseSailDateUtc(s.sailDate),
          packageCode: s.packageCode,
        },
        s
      );
    }

    return successEnvelope({
      sailingPackages: sailings,
    }) as SailingPackageResponse;
  });
}

/**
 * GraphQL-first, Stagehand-second catalog fetch. Both paths return
 * `ScrapedSailing[]`. EmptyResultsError from either is mapped to an
 * empty array per Task 10 ("empty results → return empty array, not
 * 500"). A GraphQL exception other than empty-results triggers the
 * Stagehand fallback; if that also fails, the exception propagates.
 */
async function runCatalogFetchWithFallback(
  request: SailingPackageRequest
): Promise<ScrapedSailing[]> {
  try {
    const sailings = await fetchSailingPackagesViaGraphql(request);
    if (sailings.length === 0) {
      logger.info("graphql catalog returned 0 sailings — treating as empty");
    }
    return sailings;
  } catch (err) {
    logger.warn(`graphql catalog failed, falling back to Stagehand: ${String(err).slice(0, 200)}`);
    try {
      return await runWithSession((session) => scrapeSailingPackages(session, request));
    } catch (fallbackErr) {
      if (fallbackErr instanceof EmptyResultsError) return [];
      throw fallbackErr;
    }
  }
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
    sailDate: sailDateToNumeric(r.sailDate),
    packageCode: r.packageCode,
  }));
  return successEnvelope({
    keys,
    dateTimeRange: {
      fromDateTime,
      toDateTime: formatISO(new Date()),
    },
  }) as SailingPackageChangesResponse;
}
