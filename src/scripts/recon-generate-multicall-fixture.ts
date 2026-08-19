import type { Capture } from "@/scripts/recon-shared";

/** Structural match of recon-generate.ts's internal (unexported) `ActionStep` —
 * `capture`/`varName`/`produces`/`isMultipart`/`isCrossDomain`, per
 * recon-generate.ts:1384-1397. Kept local rather than imported since the
 * source type isn't exported and every consumer of `selectPayloadAction` only
 * needs the `capture` field structurally (recon-generate.ts:313). */
export interface MulticallFixtureStep {
  capture: Capture;
  varName: string;
  produces: never[];
  isMultipart: boolean;
  isCrossDomain: boolean;
}

function buildCapture(overrides: {
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const TOGGLES_URL = "https://api.example.com/listings-avail-spa/toggles/product-avail";
const AUTHZ_URL = "https://api.example.com/listings-avail-api/authz/private";
const AVAILABLE_PRODUCTS_URL = "https://api.example.com/listings-avail-api/available-products/";
const AVAILABLE_UNITS_URL = "https://api.example.com/listings-avail-api/available-units/";

function buildStep(
  varName: string,
  overrides: {
    url: string;
    requestPostData: string | null;
    responseBody: unknown;
    timestamp: string;
  }
): MulticallFixtureStep {
  return {
    capture: buildCapture(overrides),
    varName,
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
}

/**
 * Reproduces a listings-fixture G1/G2 recon capture set: a
 * feature-toggle read, an anonymous auth mint, and an inventory search
 * re-queried with two distinct bodies (the "×N" `available-products/`
 * calls). Each of the three response SHAPES (toggles
 * array, `{result,successful}` auth mint, `{totalPages,totalAvailableListings,
 * products[]}` inventory) is disjoint from the others so tests can assert the
 * generator distinguishes per-call shapes instead of collapsing them to one
 * (G2). `available-products/` is emitted twice with different request bodies
 * — one step alone cannot carry `selectPayloadAction`'s re-query signature
 * (recon-generate.ts:313-334 requires >=2 steps at the same endpointKey with
 * distinct requestPostData) — so `selectPayloadAction` picks it over the
 * toggle/auth calls that merely opened the flow.
 */
export function buildMulticallHeterogeneousActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: TOGGLES_URL,
      requestPostData: "[]",
      responseBody: [{ name: "feature-a", enabled: true }],
      timestamp: "2024-01-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: AUTHZ_URL,
      requestPostData: "{}",
      responseBody: { result: "anonymous", successful: true },
      timestamp: "2024-01-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: AVAILABLE_PRODUCTS_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        totalPages: 5,
        totalAvailableListings: 699,
        products: [{ productId: "p1" }],
      },
      timestamp: "2024-01-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: AVAILABLE_PRODUCTS_URL,
      requestPostData: '{"page":2}',
      responseBody: {
        totalPages: 5,
        totalAvailableListings: 699,
        products: [{ productId: "p2" }],
      },
      timestamp: "2024-01-01T00:00:03Z",
    }),
  ];
}

/**
 * Same call sequence, plus a terminal drill-down call whose response is a
 * single building rather than the search result — reproducing G1's
 * "last call ≠ the flow's subject" condition (a `POST available-units/`
 * fired after the user picks one building from the products list).
 */
export function buildMulticallHeterogeneousActionStepsWithDrillDown(): MulticallFixtureStep[] {
  return [
    ...buildMulticallHeterogeneousActionSteps(),
    buildStep("r4", {
      url: AVAILABLE_UNITS_URL,
      requestPostData: '{"productId":"p1"}',
      responseBody: { units: [{ unitId: "s1" }], exchangeRate: 1.0 },
      timestamp: "2024-01-01T00:00:04Z",
    }),
  ];
}
