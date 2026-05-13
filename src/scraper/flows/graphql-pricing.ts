import { getLogger } from "@/lib/logging";
import {
  type CruiseSearchResults,
  cruiseSearchCruises,
  type GraphQlSailing,
  type GraphQlStateroomClassPrice,
} from "@/scraper/graphql";

const logger = getLogger({ name: "scraper/flows/graphql-pricing" });

/**
 * Locates ONE sailing in RC's catalog by (shipCode, sailDate, packageCode)
 * and returns its per-stateroom-class pricing directly. Backs the
 * super-category-pricing GraphQL fast-path — the catalog response already
 * has Interior/Outside/Balcony/Deluxe prices inline, so there's no need
 * to open the detail page.
 *
 * Returns `null` when the sailing is not present in the catalog (the
 * caller falls back to the Stagehand pricing flow). We intentionally
 * keep the scan scoped by `ship:XX` filter so pagination stays bounded.
 */

interface GraphqlPricingKey {
  shipCode: string;
  sailDate: string;
  packageCode: string;
}

interface GraphqlPricingResult {
  sailing: GraphQlSailing;
  stateroomClassPricing: GraphQlStateroomClassPrice[];
}

type FetchFn = (skip: number, count: number, filters: string) => Promise<CruiseSearchResults>;

interface GraphqlPricingOptions {
  fetchFn?: FetchFn;
  maxPages?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 6;

async function defaultFetch(
  skip: number,
  count: number,
  filters: string
): Promise<CruiseSearchResults> {
  return cruiseSearchCruises({
    filters,
    pagination: { count, skip },
    sort: { by: "RECOMMENDED" },
  });
}

/**
 * Walks the catalog for `ship:${shipCode}` and returns the first sailing
 * whose package + sailDate matches. The scan stops on a short page — RC's
 * `total` is non-deterministic (recon gap 6).
 */
export async function fetchSailingPricingViaGraphql(
  key: GraphqlPricingKey,
  options: GraphqlPricingOptions = {}
): Promise<GraphqlPricingResult | null> {
  const fetchFn = options.fetchFn ?? defaultFetch;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const filters = `ship:${key.shipCode}`;
  // key.sailDate is validated by sailDateStringSchema (YYYY-MM-DD or
  // YYYYMMDD). Slice directly rather than round-tripping through
  // parseISO → toISOString, which would slip a day east of UTC.
  const targetIso = key.sailDate.slice(0, 10);

  logger.info(
    `graphql pricing: ship=${key.shipCode} package=${key.packageCode} sailDate=${targetIso}`
  );

  for (let page = 0; page < maxPages; page += 1) {
    const results = await fetchFn(page * pageSize, pageSize, filters);
    const cruises = results.cruises ?? [];
    if (cruises.length === 0) break;
    for (const cruise of cruises) {
      const packageCode = cruise.masterSailing?.itinerary?.code;
      if (packageCode !== key.packageCode) continue;
      const sailing = (cruise.sailings ?? []).find((s) => s.sailDate.slice(0, 10) === targetIso);
      if (!sailing) continue;
      return {
        sailing,
        stateroomClassPricing: sailing.stateroomClassPricing ?? [],
      };
    }
    if (cruises.length < pageSize) break;
  }

  logger.info(
    `graphql pricing: no match for ship=${key.shipCode} package=${key.packageCode} sailDate=${targetIso}`
  );
  return null;
}
