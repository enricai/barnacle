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

export function buildCapture(overrides: {
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

export function buildStep(
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

const CATALOG_SEARCH_URL = "https://api.example.com/catalog/search/";
const CATALOG_ITEM_DETAIL_URL = "https://api.example.com/catalog/item-detail/";

/**
 * Reproduces a search-then-per-item-drill-down flow whose primary page
 * carries multiple results, each followed by its own drill-down call — the
 * shape {@link detectDrillDownFoldPlan} must resolve by join key rather than
 * by position. `search`/`page 2` is re-queried (distinct body from `page 1`)
 * so it satisfies {@link findRequeriedActions}'s relevance signal, and its
 * response holds two items (`i-b` then `i-a`, deliberately not alphabetical)
 * so a later merge can't assume primary-array order. The two drill-down
 * calls are fired in the OPPOSITE order of the primary array (`i-a`'s
 * drill-down first, `i-b`'s second) — a positional/index-based fold would
 * pair the wrong item with the wrong drill-down response, while a join-key
 * fold (matching each drill request's `itemId` back to the primary item that
 * produced it) pairs them correctly regardless of call order.
 */
export function buildMulticallDependentDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: { totalPages: 2, items: [{ itemId: "solo" }] },
      timestamp: "2024-03-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":2}',
      responseBody: {
        totalPages: 2,
        items: [{ itemId: "i-b" }, { itemId: "i-a" }],
      },
      timestamp: "2024-03-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_ITEM_DETAIL_URL,
      requestPostData: '{"itemId":"i-a"}',
      responseBody: { details: [{ detailId: "d-a" }] },
      timestamp: "2024-03-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: CATALOG_ITEM_DETAIL_URL,
      requestPostData: '{"itemId":"i-b"}',
      responseBody: { details: [{ detailId: "d-b" }] },
      timestamp: "2024-03-01T00:00:03Z",
    }),
  ];
}

const CHECKOUT_HOST = "https://api.example.com";

/**
 * Reproduces a wizard-style checkout submission on one host: a create-order
 * call followed by a per-section save POST for each wizard step
 * (shipping/billing/payment/review, repeated with a follow-up correction save
 * so the sequence exceeds ten distinct captures), and a final "place order"
 * click. Every section-save call is a genuine same-host, 2xx, submission POST
 * that a heuristic extractor (`extractActionSequence`) would keep — this is
 * what a real server-side-autosaving wizard produces, as opposed to
 * incidental page chrome. Site-agnostic stand-in for the reported ATS
 * apply-flow shape (recon-generate.ts's `resolveManifestActionSequence`
 * unconditionally trusting a short submit-manifest.json over this richer
 * capture set).
 */
export function buildWizardCheckoutCaptures(): Capture[] {
  const section = (
    name: string,
    index: number,
    body: Record<string, unknown>
  ): { url: string; requestPostData: string | null; responseBody: unknown; timestamp: string } => ({
    url: `${CHECKOUT_HOST}/checkout/order-42/${name}`,
    requestPostData: JSON.stringify(body),
    responseBody: { section: name, orderId: "order-42", saved: true },
    timestamp: `2024-02-01T00:00:${String(index).padStart(2, "0")}Z`,
  });

  return [
    buildCapture({
      url: `${CHECKOUT_HOST}/checkout/create-order`,
      requestPostData: JSON.stringify({ cartId: "cart-9" }),
      responseBody: { orderId: "order-42" },
      timestamp: "2024-02-01T00:00:00Z",
    }),
    buildCapture(section("shipping", 1, { line1: "1 Main St", city: "Springfield" })),
    buildCapture(section("billing", 2, { cardLast4: "4242" })),
    buildCapture(section("payment", 3, { method: "card" })),
    buildCapture(section("review", 4, { accepted: true })),
    buildCapture(section("shipping", 5, { line1: "2 Main St", city: "Springfield" })),
    buildCapture(section("billing", 6, { cardLast4: "1111" })),
    buildCapture(section("payment", 7, { method: "card", saveCard: true })),
    buildCapture(section("review", 8, { accepted: true, confirmed: true })),
    buildCapture({
      url: `${CHECKOUT_HOST}/checkout/order-42/place-order`,
      requestPostData: JSON.stringify({ confirm: true }),
      responseBody: { orderId: "order-42", status: "placed" },
      timestamp: "2024-02-01T00:00:09Z",
    }),
  ];
}
