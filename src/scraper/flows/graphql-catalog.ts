import { getLogger } from "@/lib/logging";
import type { SailingPackageFlowInput, ScrapedSailing } from "@/scraper/flows/sailing-package";
import {
  type CruiseSearchResults,
  cruiseSearchCruises,
  type GraphQlCruise,
  type GraphQlStateroomClassPrice,
} from "@/scraper/graphql";

const logger = getLogger({ name: "scraper/flows/graphql-catalog" });

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 20;

/**
 * GraphQL-backed catalog flow. Runs `cruiseSearch_Cruises` directly
 * against RC's public `/cruises/graph` endpoint — no browser, no Steel
 * session. Replaces the Stagehand flow for the hot catalog path; the
 * Stagehand flow becomes a fallback for when GraphQL drifts or errors.
 *
 * Filter strategy (per recon gap 7): RC's `$filters` string only
 * applies the FIRST key:value predicate. So we pick the most-selective
 * single predicate and enforce the rest client-side:
 *   1. shipCodes (if given) — send the first as `ship:XX`
 *   2. otherwise — empty filter, paginate full catalog
 * The date-window, remaining ship codes, and includeTourPackages are
 * applied client-side on the response.
 */

type FetchFn = (skip: number, count: number, filters: string) => Promise<CruiseSearchResults>;

export interface GraphqlCatalogOptions {
  fetchFn?: FetchFn;
  maxPages?: number;
  pageSize?: number;
}

/**
 * Runs the direct-HTTP catalog query and maps results to
 * `ScrapedSailing[]` — the same shape the Stagehand flow produces, so
 * downstream services consume both identically.
 */
export async function fetchSailingPackagesViaGraphql(
  input: SailingPackageFlowInput,
  options: GraphqlCatalogOptions = {}
): Promise<ScrapedSailing[]> {
  const fetchFn = options.fetchFn ?? defaultFetch;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = options.pageSize ?? PAGE_SIZE;

  const filters = pickMostSelectiveFilter(input);
  logger.info(
    `graphql catalog: brand=${input.brandCode} filters="${filters}" window=${input.fromSailDate}..${input.toSailDate}`
  );

  const seen = new Set<string>();
  const collected: ScrapedSailing[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const skip = page * pageSize;
    const results = await fetchFn(skip, pageSize, filters);
    const cruises = results.cruises ?? [];
    if (cruises.length === 0) break;
    for (const cruise of cruises) {
      for (const sailing of expandCruiseToSailings(cruise, input)) {
        const key = `${sailing.shipCode}|${sailing.sailDate}|${sailing.packageCode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(sailing);
      }
    }
    // `total` is non-deterministic per recon — stop when page was
    // short rather than trusting it.
    if (cruises.length < pageSize) break;
  }

  logger.info(`graphql catalog: collected ${collected.length} sailings`);
  return collected;
}

/**
 * Default fetcher — lets callers inject a mock for unit tests without
 * monkey-patching the module.
 */
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
 * Chooses a single predicate for the `$filters` variable. Recon
 * confirmed multi-key AND is silently dropped, so one predicate is all
 * we get server-side. Remaining VPS predicates are applied client-side
 * in `expandCruiseToSailings`.
 */
export function pickMostSelectiveFilter(input: SailingPackageFlowInput): string {
  if (input.shipCodes && input.shipCodes.length === 1 && input.shipCodes[0]) {
    return `ship:${input.shipCodes[0]}`;
  }
  return "";
}

/**
 * Flattens one GraphQL `cruise` into the one-row-per-sailing-date
 * shape VPS expects. Applies the date window + ship-code filter
 * client-side. Skips sailings with no usable price (rare but possible
 * for recently-cancelled dates).
 */
export function expandCruiseToSailings(
  cruise: GraphQlCruise,
  input: SailingPackageFlowInput
): ScrapedSailing[] {
  const itinerary = cruise.masterSailing?.itinerary;
  if (!itinerary) return [];
  const packageCode = itinerary.code;
  const shipCode = itinerary.ship?.code ?? "";
  const shipName = itinerary.ship?.name;
  if (!packageCode || !shipCode) return [];

  if (input.shipCodes && input.shipCodes.length > 0 && !input.shipCodes.includes(shipCode)) {
    return [];
  }

  const fromDate = input.fromSailDate;
  const toDate = input.toSailDate;
  const detailPath = cruise.productViewLink
    ? cruise.productViewLink.startsWith("http")
      ? cruise.productViewLink
      : `https://www.royalcaribbean.com/${cruise.productViewLink.replace(/^\//, "")}`
    : undefined;

  const sailings = cruise.sailings ?? [];
  const expanded: ScrapedSailing[] = [];
  for (const sailing of sailings) {
    if (sailing.sailDate < fromDate || sailing.sailDate > toDate) continue;
    const cabinOptions = mapStateroomClassPricing(sailing.stateroomClassPricing ?? []);
    expanded.push({
      brandCode: input.brandCode,
      shipCode,
      shipName,
      sailDate: sailing.sailDate,
      packageCode,
      duration: itinerary.totalNights ?? itinerary.sailingNights ?? 0,
      packageDescription: itinerary.name,
      regionCode: itinerary.destination?.code,
      subRegionCode: itinerary.departurePort?.region,
      sailingDetailUrl: detailPath,
      cabinOptions: cabinOptions.length > 0 ? cabinOptions : undefined,
    });
  }
  return expanded;
}

/**
 * Converts RC's `StateroomClassPrice[]` (I/O/B/D super-categories)
 * into the `ScrapedSailing.cabinOptions` shape. Codes are already the
 * VPS single-letter super-category codes.
 */
function mapStateroomClassPricing(prices: GraphQlStateroomClassPrice[]): {
  stateroomCategoryCode: string;
  stateroomSuperCategory: string;
  pricePerGuest: number;
  currency: string | undefined;
}[] {
  return prices
    .map((p) => {
      const code = p.stateroomClass?.content?.code ?? p.stateroomClass?.id ?? "";
      if (!code || typeof p.price?.value !== "number") return null;
      return {
        stateroomCategoryCode: code,
        stateroomSuperCategory: p.stateroomClass.id,
        pricePerGuest: p.price.value,
        currency: p.price.currency?.code,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
