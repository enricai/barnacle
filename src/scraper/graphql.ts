import { config } from "@/config";
import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "scraper/graphql" });

/**
 * Direct-HTTP client for Royal Caribbean's public `cruiseSearch_Cruises`
 * GraphQL endpoint at `POST /cruises/graph`. No browser, no Steel
 * session required for the steady-state catalog read path. Recon
 * confirmed:
 *
 *   - The endpoint is public, no auth.
 *   - `cruiseSearch_Cruises` returns the full catalog with per-sailing
 *     + per-stateroom-class pricing inline (Interior / Outside /
 *     Balcony / Suite = VPS super-categories I/O/B/D).
 *   - `$filters` is effectively single-predicate (multi-key AND is
 *     silently dropped), so callers send ONE most-selective predicate
 *     and apply the rest client-side.
 *   - No rate-limit observed up to 5 rps × 60 requests; still go
 *     through `bottleneck` for politeness when refreshing the
 *     catalog on a schedule.
 */

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
            voyageType
            destination { code name }
            departurePort { code name region }
            ship { code name }
            days {
              number
              ports {
                activity
                arrivalTime
                departureTime
                port { code name region countryCode }
              }
            }
            preTour {
              code
              duration
              days {
                number
                ports {
                  activity
                  arrivalTime
                  departureTime
                  port { code name region countryCode }
                }
              }
            }
            postTour {
              code
              duration
              days {
                number
                ports {
                  activity
                  arrivalTime
                  departureTime
                  port { code name region countryCode }
                }
              }
            }
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
          status
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

export interface CruiseSearchPagination {
  count: number;
  skip: number;
}

export interface CruiseSearchSort {
  by: "RECOMMENDED" | "PRICE_LOW_TO_HIGH" | "PRICE_HIGH_TO_LOW" | "SAIL_DATE";
}

interface CruiseSearchInput {
  filters?: string;
  qualifiers?: string;
  sort?: CruiseSearchSort;
  pagination?: CruiseSearchPagination;
}

interface GraphQlPrice {
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
  status?: string;
  taxesAndFeesIncluded?: boolean;
  stateroomClassPricing?: GraphQlStateroomClassPrice[];
}

export interface GraphQlPortVisit {
  activity?: string;
  arrivalTime?: string | null;
  departureTime?: string | null;
  port?: {
    code: string;
    name?: string | null;
    region?: string | null;
    countryCode?: string | null;
  };
}

export interface GraphQlItineraryDay {
  number: number;
  ports?: GraphQlPortVisit[];
}

export interface GraphQlTour {
  code: string;
  duration?: number | null;
  days?: GraphQlItineraryDay[] | null;
}

interface GraphQlItinerary {
  code: string;
  name?: string;
  totalNights?: number;
  sailingNights?: number;
  type?: string;
  voyageType?: string;
  destination?: { code: string; name?: string };
  departurePort?: { code: string; name?: string; region?: string };
  ship?: { code: string; name?: string };
  days?: GraphQlItineraryDay[];
  preTour?: GraphQlTour | null;
  postTour?: GraphQlTour | null;
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

interface GraphQlResponse<T> {
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
 * Failures also emit a short warn log so operators can correlate
 * upstream RC blips with their own alerts — the GraphQlRequestError
 * only contains what the caller surfaces, which is often just the
 * HTTP status.
 */
async function postGraph<T>(
  url: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const body = JSON.stringify({ operationName, query, variables });
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: DEFAULT_HEADERS,
      body,
      signal: AbortSignal.timeout(config.scraper.httpTimeoutMs),
    });
  } catch (err) {
    // AbortSignal.timeout throws a TimeoutError (DOMException-ish); node
    // surfaces it with name "TimeoutError" or "AbortError". Map both to
    // GraphQlRequestError so the service-layer fallback kicks in rather
    // than leaking a bare network error.
    const name = err instanceof Error ? err.name : "Error";
    if (name === "TimeoutError" || name === "AbortError") {
      logger.warn(
        `${operationName} upstream fetch timed out after ${config.scraper.httpTimeoutMs}ms`
      );
      throw new GraphQlRequestError(`${operationName} timed out`, 504);
    }
    throw err;
  }
  if (!response.ok) {
    logger.warn(`${operationName} upstream HTTP ${response.status} from ${url}`);
    throw new GraphQlRequestError(
      `${operationName} returned HTTP ${response.status}`,
      response.status
    );
  }
  const payload = (await response.json()) as GraphQlResponse<T>;
  if (payload.errors && payload.errors.length > 0) {
    const message = payload.errors.map((e) => e.message).join("; ");
    logger.warn(`${operationName} upstream graphql errors: ${message.slice(0, 200)}`);
    throw new GraphQlRequestError(`${operationName} errors: ${message}`, 200);
  }
  if (!payload.data) {
    logger.warn(`${operationName} upstream returned 200 with empty data`);
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
