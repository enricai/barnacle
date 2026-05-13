import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "scraper/graphql" });

/**
 * Direct-HTTP client for Royal Caribbean's public GraphQL endpoints —
 * `POST /graph` and `POST /cruises/graph`. No browser, no Steel session
 * required for the steady-state catalog read path. Recon captured in
 * iterations 7-9 confirmed:
 *
 *   - Both endpoints are public, no auth.
 *   - `cruiseSearch_Cruises` returns the full catalog with
 *     per-sailing + per-stateroom-class pricing inline (Interior /
 *     Outside / Balcony / Suite = VPS super-categories I/O/B/D).
 *   - `bestPromotionForMarket` drives promotion-details.
 *   - `$filters` is effectively single-predicate (multi-key AND is
 *     silently dropped), so callers send ONE most-selective predicate
 *     and apply the rest client-side.
 *   - No rate-limit observed up to 5 rps × 60 requests; still go
 *     through `bottleneck` for politeness when refreshing the
 *     catalog on a schedule.
 */

const GRAPH_URL = "https://www.royalcaribbean.com/graph";
const CRUISES_GRAPH_URL = "https://www.royalcaribbean.com/cruises/graph";

const DEFAULT_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/json",
  origin: "https://www.royalcaribbean.com",
  referer: "https://www.royalcaribbean.com/cruises",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
};

/**
 * Lean `cruiseSearch_Cruises` query — only the fields we need to fill
 * the VPS sailing-package + super-category-pricing envelopes. The full
 * SPA query is 7KB and selects UI-only fields we don't project
 * (highlights, images, etc.).
 */
const CRUISE_SEARCH_QUERY = `query cruiseSearch_Cruises(
  $filters: String
  $qualifiers: String
  $sort: CruiseSearchSort
  $pagination: CruiseSearchPagination
) {
  cruiseSearch(
    filters: $filters
    qualifiers: $qualifiers
    sort: $sort
    pagination: $pagination
  ) {
    results {
      total
      cruises {
        id
        productViewLink
        masterSailing {
          itinerary {
            code
            name
            totalNights
            sailingNights
            type
            destination { code name }
            departurePort { code name region }
            ship { code name }
          }
        }
        lowestPriceSailing {
          id
          sailDate
          startDate
          endDate
          lowestStateroomClassPrice {
            price { value currency { code } }
            stateroomClass { id content { code } }
          }
        }
        sailings {
          id
          sailDate
          startDate
          endDate
          taxesAndFeesIncluded
          stateroomClassPricing {
            price {
              value
              originalAmount
              netAmount
              discountAmount
              taxesAndFeesAmount
              areTaxesAndFeesIncluded
              currency { code }
            }
            stateroomClass { id content { code } }
          }
        }
      }
    }
  }
}`;

const BEST_PROMOTION_QUERY = `query bestPromotionForMarket(
  $country: String
  $currency: String
  $language: String
  $displayQualifier: Boolean
) {
  bestPromotionForMarket(
    country: $country
    currency: $currency
    language: $language
    displayQualifier: $displayQualifier
  ) {
    id
    code
    name
    description
    startDate
    endDate
  }
}`;

export interface CruiseSearchPagination {
  count: number;
  skip: number;
}

export interface CruiseSearchSort {
  by: "RECOMMENDED" | "PRICE_LOW_TO_HIGH" | "PRICE_HIGH_TO_LOW" | "SAIL_DATE";
}

export interface CruiseSearchInput {
  filters?: string;
  qualifiers?: string;
  sort?: CruiseSearchSort;
  pagination?: CruiseSearchPagination;
}

export interface GraphQlPrice {
  value: number;
  originalAmount?: number;
  netAmount?: number;
  discountAmount?: number;
  taxesAndFeesAmount?: number;
  areTaxesAndFeesIncluded?: boolean;
  currency?: { code: string };
}

export interface GraphQlStateroomClassPrice {
  price: GraphQlPrice;
  stateroomClass: { id: string; content: { code: string } };
}

export interface GraphQlSailing {
  id: string;
  sailDate: string;
  startDate?: string;
  endDate?: string;
  taxesAndFeesIncluded?: boolean;
  stateroomClassPricing?: GraphQlStateroomClassPrice[];
}

export interface GraphQlItinerary {
  code: string;
  name?: string;
  totalNights?: number;
  sailingNights?: number;
  type?: string;
  destination?: { code: string; name?: string };
  departurePort?: { code: string; name?: string; region?: string };
  ship?: { code: string; name?: string };
}

export interface GraphQlCruise {
  id: string;
  productViewLink?: string;
  masterSailing?: { itinerary?: GraphQlItinerary };
  lowestPriceSailing?: {
    id: string;
    sailDate: string;
    startDate?: string;
    endDate?: string;
    lowestStateroomClassPrice?: GraphQlStateroomClassPrice;
  };
  sailings?: GraphQlSailing[];
}

export interface CruiseSearchResults {
  total: number;
  cruises: GraphQlCruise[];
}

export interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Thrown when the upstream returns an HTTP non-2xx or a GraphQL
 * `errors` array. Callers in `sailing-catalog.ts` catch this and fall
 * back to the Stagehand flow.
 */
export class GraphQlRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GraphQlRequestError";
    this.status = status;
  }
}

/**
 * Low-level POST helper used by the typed wrappers below. Logs the
 * endpoint + op name but not the full query/body (they're large).
 */
async function postGraph<T>(
  url: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const body = JSON.stringify({ operationName, query, variables });
  const response = await fetch(url, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body,
  });
  if (!response.ok) {
    throw new GraphQlRequestError(
      `${operationName} returned HTTP ${response.status}`,
      response.status
    );
  }
  const payload = (await response.json()) as GraphQlResponse<T>;
  if (payload.errors && payload.errors.length > 0) {
    const message = payload.errors.map((e) => e.message).join("; ");
    throw new GraphQlRequestError(`${operationName} errors: ${message}`, 200);
  }
  if (!payload.data) {
    throw new GraphQlRequestError(`${operationName}: empty data`, 200);
  }
  return payload.data;
}

/**
 * Runs a single page of `cruiseSearch_Cruises`. Callers paginate by
 * varying `pagination.skip`; the response's `total` is non-deterministic
 * per recon (can drift ±20%), so stop when the returned cruises array
 * is shorter than requested count rather than trusting total.
 */
export async function cruiseSearchCruises(
  input: CruiseSearchInput = {}
): Promise<CruiseSearchResults> {
  const variables = {
    filters: input.filters ?? "",
    qualifiers: input.qualifiers ?? "",
    sort: input.sort ?? { by: "RECOMMENDED" },
    pagination: input.pagination ?? { count: 100, skip: 0 },
  };
  logger.info(
    `cruiseSearch_Cruises: filters="${variables.filters}" count=${variables.pagination.count} skip=${variables.pagination.skip}`
  );
  const data = await postGraph<{ cruiseSearch: { results: CruiseSearchResults } }>(
    CRUISES_GRAPH_URL,
    "cruiseSearch_Cruises",
    CRUISE_SEARCH_QUERY,
    variables
  );
  return data.cruiseSearch.results;
}

export interface BestPromotionInput {
  country?: string;
  currency?: string;
  language?: string;
  displayQualifier?: boolean;
}

export interface BestPromotion {
  id: string;
  code?: string;
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Fetches the best promotion for a market. Powers the VPS
 * `promotion-details` endpoint for market-scoped queries.
 */
export async function bestPromotionForMarket(
  input: BestPromotionInput = {}
): Promise<BestPromotion | null> {
  const variables: Record<string, unknown> = {
    country: input.country ?? "USA",
    currency: input.currency ?? "USD",
    language: input.language ?? "en",
    displayQualifier: input.displayQualifier ?? false,
  };
  logger.info(
    `bestPromotionForMarket: country=${variables.country as string} currency=${variables.currency as string}`
  );
  const data = await postGraph<{ bestPromotionForMarket: BestPromotion | null }>(
    GRAPH_URL,
    "bestPromotionForMarket",
    BEST_PROMOTION_QUERY,
    variables
  );
  return data.bestPromotionForMarket;
}
