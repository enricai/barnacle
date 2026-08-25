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
  requestHeaders?: Record<string, string>;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: overrides.requestHeaders ?? { "Content-Type": "application/json" },
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
    requestHeaders?: Record<string, string>;
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

const CATALOG_PRICING_URL = "https://api.example.com/catalog/pricing/";

/**
 * A search → per-item drill-down flow whose search endpoint fires exactly
 * ONCE. {@link detectDrillDownFoldPlan} now scans every prior action as a
 * fold-primary candidate, so a single-shot search is just as eligible as a
 * re-queried one — but the primary response here also carries a decoy
 * `facets[]` array ahead of the real `results[]`, so `findObjectArrayField`'s
 * DFS first-match deliberately disagrees with the array a caller would fold
 * onto. `resolveFoldPlan(steps)` on this fixture still returns `null`, but
 * only because of that decoy, not because the search fires once. That
 * decoy-vs-declared-path gap is the shape the flow-declared `foldReturn`
 * (`FoldReturnSpec`/`resolveFoldPlan`) exists to reach.
 *
 * The decoy is load-bearing for a `resolveFoldPlan`/`foldReturn` test
 * elsewhere; {@link buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps}
 * is the decoy-free sibling used to prove `detectDrillDownFoldPlan` alone
 * detects a single-shot primary.
 */
export function buildMulticallSingleShotSearchDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        facets: [{ name: "brand" }],
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

/**
 * A search → per-item drill-down flow whose search response is unambiguous
 * (a single `results[]` array, no decoy), but whose DRILL step's response
 * carries a decoy `errors[]` array ahead of the real per-item `details[]`
 * array. `findObjectArrayField`'s DFS first-match lands on `errors[]`
 * instead of `details[]` when resolving the drill side of the fold, so a
 * `foldReturn` declaration that only names the primary's `resultsPath`
 * (see {@link FoldReturnSpec}) cannot fix this — the gap is on the drill
 * side, not the primary side. Proves a drill-side results-path declaration
 * (as opposed to {@link buildMulticallSingleShotSearchDrillDownActionSteps}'s
 * primary-side decoy) is what a `drillResultsPath`-style flow declaration
 * exists to reach.
 */
export function buildMulticallSingleShotSearchDrillDownDrillDecoyActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: {
        errors: [{ code: "none" }],
        details: [{ sku: "sku-a", price: 19.99 }],
      },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

/**
 * A decoy-free sibling of {@link buildMulticallSingleShotSearchDrillDownActionSteps}:
 * the search endpoint still fires exactly once, but `results[]` is the sole
 * object-array field in its response, so `findObjectArrayField`'s DFS
 * first-match lands on the real results array with no declared `foldReturn`
 * needed. Proves the single-shot primary is detected on structure alone.
 */
export function buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

/**
 * A nested-join-key sibling of {@link buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps}
 * with a SECOND primary item, so a per-item fold loop is actually exercised
 * (not just a single-item detection check): each primary `results[]` item
 * carries its join key under a nested `identifiers` object
 * (`{ identifiers: { sku } }`) instead of as a top-level field, while the
 * drill-down request is still keyed by the plain `sku` value pulled out of
 * that nested field. Proves the fold loop threads a join key found by
 * walking INTO an item's nested objects, not only its own top-level
 * `Object.entries`, across every primary item.
 */
export function buildMulticallSingleShotSearchDrillDownNestedJoinFieldMultiItemActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ identifiers: { sku: "sku-a" } }, { identifiers: { sku: "sku-b" } }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

/**
 * A search → per-item drill-down flow whose DRILL step's response carries
 * BOTH a small real nested object-array field (`tags[]`, one primitive
 * field per item, no join echo) AND richer flat top-level per-item fields
 * (`name`/`price`/`brand`, none of them echoing the join either) — the
 * shape {@link findAllObjectArrayFieldsOrWholeObject}'s old docstring
 * ("a response that already has one [a real object-array field] is never
 * second-guessed") resolved to the tiny `tags[]` array instead of the
 * richer flat object. Neither candidate threads the join value in its
 * response body (only the drill REQUEST carries `sku-a`), so selection must
 * fall through to comparing per-item primitive-field richness, which the
 * flat object wins 3 (`name`/`price`/`brand`) to 1 (`tags[0].id`).
 */
export function buildMulticallSingleShotSearchDrillDownRicherFlatOutranksNestedArrayActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: {
        tags: [{ id: 1 }, { id: 2 }],
        name: "Widget A",
        price: 19.99,
        brand: "Acme",
      },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

const CATALOG_INVENTORY_URL = "https://api.example.com/catalog/inventory/";

/**
 * A decoy-free sibling of {@link buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps}
 * with a SECOND, independently-threaded per-item drill-down appended: the
 * primary `results[]` items carry both a `sku` (joined to the pricing drill)
 * and an `itemId` (joined to this inventory drill), and neither drill
 * step's response overlaps the other's fields. Proves the fold loop merges
 * fields from every independent target onto each item, not just the first.
 */
export function buildMulticallSingleShotSearchTwoIndependentDrillDownsActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [
          { sku: "sku-a", itemId: "item-a" },
          { sku: "sku-b", itemId: "item-b" },
        ],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_INVENTORY_URL,
      requestPostData: '{"itemId":"item-a"}',
      responseBody: { stock: [{ itemId: "item-a", qty: 7 }] },
      timestamp: "2024-04-01T00:00:02Z",
    }),
  ];
}

/**
 * A sibling of {@link buildMulticallSingleShotSearchTwoIndependentDrillDownsActionSteps}
 * where BOTH per-item drills are threaded off the SAME primary join field
 * (`sku`), rather than disjoint fields (`sku`/`itemId`). Each drill's
 * response echoes that shared `sku` value back alongside its own field —
 * an echo of the primary's own join value, not evidence the second drill
 * depends on the first drill's response. Proves the fold loop still emits
 * and merges BOTH independent drills onto every primary item even when
 * their echoed join values collide, rather than collapsing the second
 * drill into a chain under the first.
 */
export function buildMulticallSingleShotSearchTwoIndependentDrillDownsSharedJoinFieldActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_INVENTORY_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { stock: [{ sku: "sku-a", qty: 7 }] },
      timestamp: "2024-04-01T00:00:02Z",
    }),
  ];
}

const CATALOG_VENDORS_SEARCH_URL = "https://api.example.com/catalog/vendors/search";
const CATALOG_VENDOR_CONTRACTS_URL = "https://api.example.com/catalog/vendors/contracts/";

/**
 * TWO independent primary/drill-down pairs, fully disjoint in both endpoint
 * and step range: a products search folded by a per-product reviews drill
 * (r0/r1), and an UNRELATED vendors search folded by a per-vendor contracts
 * drill (r2/r3). Neither primary's items reference the other pair's join key
 * (`productId` vs `vendorId`), so this proves the fold emitter resolves and
 * loops over every independent plan, not only the first one it finds.
 */
export function buildMulticallTwoIndependentPrimariesActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        products: [{ productId: "p1" }, { productId: "p2" }],
      },
      timestamp: "2024-05-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"productId":"p1"}',
      responseBody: { reviews: [{ productId: "p1", rating: 5 }] },
      timestamp: "2024-05-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_VENDORS_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        vendors: [{ vendorId: "v1" }, { vendorId: "v2" }],
      },
      timestamp: "2024-05-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: CATALOG_VENDOR_CONTRACTS_URL,
      requestPostData: '{"vendorId":"v1"}',
      responseBody: { contracts: [{ vendorId: "v1", contractId: "c1" }] },
      timestamp: "2024-05-01T00:00:03Z",
    }),
  ];
}

/**
 * Same disjoint two-pair shape as
 * {@link buildMulticallTwoIndependentPrimariesActionSteps}, except the SECOND
 * pair's join value threads only through a request HEADER
 * (`collectRequestStringValues` never scans headers), so
 * `detectDrillDownFoldPlan`'s structural heuristic resolves only the FIRST
 * pair (r0/r1) on its own; the second pair (r2/r3) is only reachable via a
 * flow-declared `foldReturn` spec naming `vendors` as its `resultsPath`.
 * Since the second pair's primary/drill steps (2, 3) are entirely outside the
 * first pair's own consumed indices ({@link buildMulticallTwoIndependentPrimariesActionSteps}'s
 * r0/r1), a correctly-behaving `resolveFoldPlan` must APPEND the spec's plan
 * as a second, independent entry rather than discarding it just because its
 * primary differs from the one the heuristic already resolved.
 */
export function buildMulticallTwoIndependentPrimariesSecondHeaderThreadedActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        products: [{ productId: "p1" }, { productId: "p2" }],
      },
      timestamp: "2024-05-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"productId":"p1"}',
      responseBody: { reviews: [{ productId: "p1", rating: 5 }] },
      timestamp: "2024-05-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_VENDORS_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        vendors: [{ vendorId: "v1" }, { vendorId: "v2" }],
      },
      timestamp: "2024-05-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: CATALOG_VENDOR_CONTRACTS_URL,
      requestPostData: '{"lookup":true}',
      responseBody: { contracts: [{ vendorId: "v1", contractId: "c1" }] },
      timestamp: "2024-05-01T00:00:03Z",
      requestHeaders: { "Content-Type": "application/json", "X-Vendor-Id": "v1" },
    }),
  ];
}

const CATALOG_STOCK_URL = "https://api.example.com/catalog/stock/";

/** A single-shot search drilled by two INDEPENDENT later calls whose join
 * values thread through different surfaces: the pricing step's `sku` lands
 * in its JSON body (heuristically detectable by `collectRequestStringValues`),
 * while the stock step's `itemId` is carried ONLY in a request header —
 * `collectRequestStringValues` never scans headers, so that fold can only be
 * resolved via a flow-declared `foldReturn` spec. Every downstream unit and
 * runtime test that needs one mixed-source, two-target fold scenario should
 * share this fixture rather than inventing its own. */
export function buildMulticallSingleShotSearchHeuristicAndSpecTwoTargetActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [
          { sku: "sku-a", itemId: "item-a" },
          { sku: "sku-b", itemId: "item-b" },
        ],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2024-04-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_STOCK_URL,
      requestPostData: '{"lookup":true}',
      responseBody: { stock: [{ itemId: "item-a", qty: 7 }] },
      timestamp: "2024-04-01T00:00:02Z",
      requestHeaders: { "Content-Type": "application/json", "X-Item-Id": "item-a" },
    }),
  ];
}

/**
 * TWO occurrences of the SAME primary endpoint (same origin+pathname,
 * differing only by query string), each independently drilling a
 * DIFFERENT item into a DIFFERENT dependent call — unlike
 * {@link buildMulticallSingleShotSearchDrillDownRequeriedPrimaryOverlapActionSteps}
 * (whose two occurrences thread the SAME drill), these thread two distinct
 * drills, so {@link detectDrillDownFoldPlan}'s freshest-wins collapse never
 * applies and both occurrences resolve as their own independent
 * {@link FoldPlan}. Both plans' primary responses share the SAME top-level
 * array key (`results`) — the exact shape a plain `{ ...a, ...b }`
 * object-spread silently collapses to the later plan's array alone, since
 * the emitted return statement folds every resolved plan's own primary var
 * together into the runtime response.
 */
export function buildMulticallTwoOccurrencesSamePrimaryDistinctDrillsActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: `${CATALOG_SEARCH_URL}?q=widgets`,
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-a" }] },
      timestamp: "2025-01-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: { prices: [{ sku: "sku-a", amount: 19.99 }] },
      timestamp: "2025-01-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: `${CATALOG_SEARCH_URL}?q=gadgets`,
      requestPostData: '{"page":1}',
      responseBody: { results: [{ sku: "sku-c" }] },
      timestamp: "2025-01-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: CATALOG_INVENTORY_URL,
      requestPostData: '{"sku":"sku-c"}',
      responseBody: { stock: [{ sku: "sku-c", qty: 4 }] },
      timestamp: "2025-01-01T00:00:03Z",
    }),
  ];
}

const CATALOG_SECTIONS_URL = "https://api.example.com/catalog/sections";
const CATALOG_ENTRY_DETAIL_URL = "https://api.example.com/catalog/entries/e2/details";

/**
 * A grouped, nested-primary drill-down whose primary response carries TWO
 * outer `sections[]` groups rather than the single group every other nested
 * fixture in this file uses, with the drilled entry living in the SECOND
 * group's `entries[]`, not the first. A fold that assumes the matched item
 * always lives in group 0 (as a single-group fixture can never disprove)
 * would resolve the fold onto `sections[0]` and silently attach the drill
 * response's `description` to the wrong entry.
 */
export function buildMulticallNestedGroupedDrillDownMultiGroupActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SECTIONS_URL,
      requestPostData: null,
      responseBody: {
        sections: [
          {
            label: "featured",
            entries: [
              { entryId: "e1", name: "Widget" },
              { entryId: "e3", name: "Doohickey" },
            ],
          },
          {
            label: "clearance",
            entries: [
              { entryId: "e2", name: "Gadget" },
              { entryId: "e4", name: "Thingamajig" },
            ],
          },
        ],
      },
      timestamp: "2024-11-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_ENTRY_DETAIL_URL,
      requestPostData: null,
      responseBody: { details: [{ entryId: "e2", description: "A gadget." }] },
      timestamp: "2024-11-01T00:00:01Z",
    }),
  ];
}

const ACCOUNT_SEARCH_URL = "https://api.example.com/accounts/search";
const ACCOUNT_DETAIL_URL = "https://api.example.com/accounts/detail";

/**
 * A single-shot search whose primary item join field (`accountId`) is a
 * NUMBER rather than a string, threaded into the drill-down call via a URL
 * query parameter (`?accountId=42`). `URLSearchParams` always stringifies its
 * values, so the request-collection side already captures `"42"` as a
 * string; the item side of the join is what must widen to accept a numeric
 * leaf for {@link detectDrillDownFoldPlan} to resolve `accountId` as a join
 * field at all.
 */
export function buildMulticallSingleShotSearchDrillDownNumericJoinActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { accounts: [{ accountId: 42, name: "Acme" }] },
      timestamp: "2024-05-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${ACCOUNT_DETAIL_URL}?accountId=42`,
      requestPostData: null,
      responseBody: { transactions: [{ transactionId: "t1" }] },
      timestamp: "2024-05-01T00:00:01Z",
    }),
  ];
}

/**
 * A single-shot search whose primary item join field (`accountId`) is
 * threaded into the drill-down call ONLY as a URL path segment
 * (`/accounts/42/transactions`) — never as a query param or a JSON body
 * value. REST-style APIs commonly shape drill-down calls this way, but
 * `collectRequestStringValues` only harvested query params and JSON body
 * leaves, so this join field was invisible to `findThreadedJoinFields` and
 * {@link detectDrillDownFoldPlan} returned null for this shape.
 */
export function buildMulticallSingleShotSearchDrillDownPathThreadedJoinActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { accounts: [{ accountId: 42, name: "Acme" }] },
      timestamp: "2024-07-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/accounts/42/transactions",
      requestPostData: null,
      responseBody: { transactions: [{ transactionId: "t1" }] },
      timestamp: "2024-07-01T00:00:01Z",
    }),
  ];
}

/**
 * A single-shot search whose primary item join field (`sku`) sits inside a
 * NESTED object (`{ identifiers: { sku } }`) rather than as a top-level
 * property. `findThreadedJoinFields` must walk into nested plain objects to
 * find it, and the resulting joinFields entry is the dot-separated path
 * `"identifiers.sku"`, not the bare leaf name `"sku"`.
 */
export function buildMulticallSingleShotSearchDrillDownNestedJoinFieldActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { accounts: [{ identifiers: { sku: "SKU-1" }, name: "Acme" }] },
      timestamp: "2024-08-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: ACCOUNT_DETAIL_URL,
      requestPostData: JSON.stringify({ sku: "SKU-1" }),
      responseBody: { transactions: [{ transactionId: "t1" }] },
      timestamp: "2024-08-01T00:00:01Z",
    }),
  ];
}

/**
 * A single-shot search whose primary items carry a COMPOSITE join key mixing
 * a string field (`region`) and a numeric field (`accountId`), both threaded
 * into the drill-down request. `findThreadedJoinFields` filters candidate
 * fields independently per entry, so a numeric field dropped alongside a
 * present string field would silently degrade the fold to a partial
 * (string-only) join key rather than failing outright — this fixture proves
 * both survive together, in the item's own key order.
 */
export function buildMulticallSingleShotSearchDrillDownCompositeNumericJoinActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { accounts: [{ region: "us", accountId: 7, name: "Acme" }] },
      timestamp: "2024-06-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${ACCOUNT_DETAIL_URL}?region=us&accountId=7`,
      requestPostData: null,
      responseBody: { transactions: [{ transactionId: "t1" }] },
      timestamp: "2024-06-01T00:00:01Z",
    }),
  ];
}

/**
 * A decoy-free single-shot search sibling of
 * {@link buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps} whose
 * `results[]` has TWO items, but whose only captured drill-down call was
 * made for the SECOND item (`sku-b`), not the first. A heuristic that always
 * pairs the primary's `results[0]` with the sole drill step would thread
 * `sku-a` into the fold even though the captured request body only ever
 * mentions `sku-b` — proving the fold must select the drill call's item by
 * matching the join field's actual value, not by array position.
 */
export function buildMulticallSingleShotSearchDrillDownNonFirstItemSkuActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-b"}',
      responseBody: { prices: [{ sku: "sku-b", amount: 24.99 }] },
      timestamp: "2024-09-01T00:00:01Z",
    }),
  ];
}

/**
 * A composite-join sibling of
 * {@link buildMulticallSingleShotSearchDrillDownCompositeNumericJoinActionSteps}
 * whose `accounts[]` has TWO items, but whose only captured drill-down call
 * threads the SECOND item's composite join key (`region: "eu"`,
 * `accountId: 9`), never the first item's (`region: "us"`, `accountId: 7`).
 * Proves the same non-first-item selection requirement holds when the join
 * key is composite, not just when it's a single field.
 */
export function buildMulticallSingleShotSearchDrillDownCompositeNumericJoinNonFirstItemActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: {
        accounts: [
          { region: "us", accountId: 7, name: "Acme" },
          { region: "eu", accountId: 9, name: "Globex" },
        ],
      },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${ACCOUNT_DETAIL_URL}?region=eu&accountId=9`,
      requestPostData: null,
      responseBody: { transactions: [{ transactionId: "t2" }] },
      timestamp: "2024-09-01T00:00:01Z",
    }),
  ];
}

/**
 * A single-shot search whose primary item join field (`accountId`) is
 * threaded into the drill-down call ONLY via a custom request header
 * (`X-Account-Id`) — never a query param, JSON body value, or URL path
 * segment. `collectRequestStringValues` deliberately never scans
 * `requestHeaders` (recon-generate.ts:4787-4815), so this join is invisible
 * to `findThreadedJoinFields` and {@link detectDrillDownFoldPlan} must return
 * `null` here regardless of how many other threading channels it learns to
 * scan — only a flow-declared `foldReturn` naming `accountId` can resolve
 * this fold.
 */
export function buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { accounts: [{ accountId: 42, name: "Acme" }] },
      timestamp: "2024-08-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: ACCOUNT_DETAIL_URL,
      requestPostData: null,
      requestHeaders: { "Content-Type": "application/json", "X-Account-Id": "42" },
      responseBody: { transactions: [{ transactionId: "t1" }] },
      timestamp: "2024-08-01T00:00:01Z",
    }),
  ];
}

/**
 * A sibling of {@link buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps}
 * whose primary endpoint is hit TWICE (`r0`, `r1`), each occurrence's single
 * `accounts[]` item independently satisfying the drill-down's `X-Account-Id`
 * join on its own — mirroring
 * {@link buildMulticallSingleShotSearchDrillDownRequeriedPrimaryOverlapActionSteps}'s
 * requeried-primary-overlap shape, but with the join threaded ONLY through a
 * request header rather than a URL query param, so `detectDrillDownFoldPlan`'s
 * structural heuristic can never see it (same blind spot documented on
 * {@link buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps}).
 * Only a flow-declared `foldReturn` naming `accountId` can resolve this fold,
 * isolating `buildFoldPlanFromSpec`'s own freshest-wins primary lookahead:
 * the resolved plan must anchor on `r1` (the LATER occurrence) and its
 * differing `name` value ("Acme Corp"), not `r0`'s stale "Acme".
 */
export function buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinRequeriedPrimaryOverlapActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { accounts: [{ accountId: 42, name: "Acme" }] },
      timestamp: "2024-08-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 2 }),
      responseBody: { accounts: [{ accountId: 42, name: "Acme Corp" }] },
      timestamp: "2024-08-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: ACCOUNT_DETAIL_URL,
      requestPostData: null,
      requestHeaders: { "Content-Type": "application/json", "X-Account-Id": "42" },
      responseBody: { transactions: [{ transactionId: "t1" }] },
      timestamp: "2024-08-01T00:00:02Z",
    }),
  ];
}

/**
 * Sibling of {@link buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps}
 * whose primary `accounts[]` array holds TWO items rather than one, so a
 * runtime fold loop built from this capture must re-key the drill-down's
 * request header per iteration rather than replaying the single captured
 * header value.
 *
 * Threaded on `API-Token` rather than the sibling fixture's `X-Account-Id`:
 * `emitMultiStepExecuteHttp`'s per-call header emission only ever renders a
 * captured header back into the generated request when it recognizes the
 * header name (`API-Token`/`Authorization`, or a base-URL-/tenant-derived
 * header passed in separately — recon-generate.ts:4273-4279) — an arbitrary
 * custom header like `X-Account-Id` is captured but never re-emitted, so a
 * fold loop built from it would have nothing to re-key at runtime. `API-Token`
 * is still a request header the join value reaches through NO OTHER channel
 * (not the URL, which is identical on every call, and not the body, which is
 * empty), so it still exercises the same header-threaded-join runtime path
 * {@link buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps}
 * demonstrates is invisible to the structural heuristic.
 *
 * The captured drill call was made for `accountId: 43` (the SECOND item),
 * pinning `primaryMatchedItemIndex` away from the index-0 default.
 */
export function buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinMultiItemActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: {
        accounts: [
          { accountId: 42, name: "Acme" },
          { accountId: 43, name: "Globex" },
        ],
      },
      timestamp: "2024-08-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: ACCOUNT_DETAIL_URL,
      requestPostData: null,
      requestHeaders: { "Content-Type": "application/json", "API-Token": "43" },
      responseBody: { transactions: [{ transactionId: "t2" }] },
      timestamp: "2024-08-01T00:00:01Z",
    }),
  ];
}

/**
 * A single-shot search whose primary results array is NOT drilled into at
 * item 0 — only a single later drill call exists, and it threads the second
 * item's (`itemId: "i-a"`) join value, never the first's (`itemId: "i-b"`).
 * With no coincidental extra call re-drilling item 0 (unlike
 * {@link buildMulticallDependentDrillDownActionSteps}, whose items are also
 * out of order but which happens to pass a items[0]-only match because a
 * third step re-drills item 0), this pins {@link detectDrillDownFoldPlan}'s
 * item search to the actually-drilled item rather than an index-0 default —
 * the search must find the match at `primaryMatchedItemIndex` 1.
 * Named "OutOfOrder" (rather than "NonFirstItem") to avoid colliding with
 * {@link buildMulticallSingleShotSearchDrillDownNonFirstItemSkuActionSteps}.
 */
export function buildMulticallSingleShotSearchDrillDownOutOfOrderItemActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ itemId: "i-b" }, { itemId: "i-a" }],
      },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"itemId":"i-a"}',
      responseBody: { prices: [{ itemId: "i-a", amount: 19.99 }] },
      timestamp: "2024-09-01T00:00:01Z",
    }),
  ];
}

/**
 * A single-shot search sibling of
 * {@link buildMulticallSingleShotSearchDrillDownNonFirstItemSkuActionSteps}
 * whose axis is on the DRILL side rather than the primary side: the primary
 * `results[]` has a single item (`sku-a`), but the drill-down's own
 * `prices[]` array comes back holding TWO entries — a decoy for an unrelated
 * sku (`sku-z`, listed first) alongside the real match (`sku-a`, listed
 * second). A fold that merges `foldMatches[0]`/`drillItems?.[0]` would
 * silently splice the decoy's `amount` onto the primary item; only matching
 * the drill array's own entries against the threaded join field (`sku`)
 * picks the correct one, at a non-zero index within that array.
 */
export function buildMulticallSingleShotSearchDrillDownMultiMatchActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }],
      },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: {
        prices: [
          { sku: "sku-z", amount: 5.0 },
          { sku: "sku-a", amount: 19.99 },
        ],
      },
      timestamp: "2024-09-01T00:00:01Z",
    }),
  ];
}

/**
 * A multi-match sibling of
 * {@link buildMulticallSingleShotSearchDrillDownMultiMatchActionSteps} whose
 * join field's type DIFFERS across the two sides: the primary item's
 * `accountId` is a NUMBER, while every item in the drill-down response's
 * array carries `accountId` as a STRING (as request-threaded values always
 * are). A decoy entry is listed first with a string that never equals the
 * primary's numeric value even after coercion; only the second entry's
 * string stringifies to the primary's value. A fold that matches via strict
 * equality (`m["accountId"] === item.accountId`, i.e. `"42" === 42`) fails
 * for every candidate here, proving the fold must compare join values by
 * their string representation, not by strict identity.
 */
export function buildMulticallSingleShotSearchDrillDownTypeMismatchJoinActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { accounts: [{ accountId: 42, name: "Acme" }] },
      timestamp: "2024-10-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${ACCOUNT_DETAIL_URL}?accountId=42`,
      requestPostData: null,
      responseBody: {
        transactions: [
          { accountId: "99", transactionId: "decoy" },
          { accountId: "42", transactionId: "t-real" },
        ],
      },
      timestamp: "2024-10-01T00:00:01Z",
    }),
  ];
}

/**
 * Same shape as {@link buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps},
 * but the CHAIN's second step (the price-history call `r2`, not the drill
 * step `r1` itself) is a multipart upload rather than a JSON POST.
 * `emitMultiStepExecuteHttp`'s fold loop re-issues EVERY chain step's
 * request per item by re-keying its rendered JSON body template — a
 * multipart step anywhere in `chain`, not just at `drillStepIndex`, has no
 * such template to re-key, so `resolveFoldPlan` must disqualify the whole
 * plan here exactly as it already does when the drill step itself is
 * multipart.
 */
export function buildMulticallSingleShotSearchDrillDownChainedDependentMultipartChainStepActionSteps(): MulticallFixtureStep[] {
  const steps = buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps();
  return steps.map((step, index) => (index === 2 ? { ...step, isMultipart: true } : step));
}

const CATALOG_PRICE_HISTORY_URL = "https://api.example.com/catalog/price-history";

/**
 * A single-shot search → per-item drill-down flow whose drill step's OWN
 * response is foldable on its own terms — it carries `prices[]`, the same
 * per-item results shape {@link buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps}
 * would fold directly — but is ALSO depended on by a THIRD step: the drill
 * response's `priceToken` threads into a price-history call whose response
 * carries the real per-item array this flow means to fold. `computeFoldChain`
 * must extend the plan's chain to `[drillStepIndex, historyStepIndex]`
 * instead of stopping at the drill step's own array, so
 * `emitMultiStepExecuteHttp`'s fold loop renders BOTH calls per item and
 * shape inference ({@link foldResponseBodyForShapeInference}) folds the
 * chain's TERMINAL (history) response, not the drill step's own `prices[]`.
 */
export function buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-11-15T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: {
        priceToken: "tok-a1",
        prices: [{ sku: "sku-a", amount: 19.99 }],
      },
      timestamp: "2024-11-15T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_PRICE_HISTORY_URL,
      requestPostData: '{"priceToken":"tok-a1"}',
      responseBody: {
        history: [{ sku: "sku-a", amount: 18.5, asOf: "2024-11-01" }],
      },
      timestamp: "2024-11-15T00:00:02Z",
    }),
  ];
}

/**
 * A nested-join-key sibling of {@link buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps}:
 * each primary `results[]` item carries its join key under a nested
 * `identifiers` object (`{ identifiers: { sku } }`, matching
 * {@link buildMulticallSingleShotSearchDrillDownNestedJoinFieldMultiItemActionSteps})
 * rather than as a top-level field, AND (as in the chained-dependent fixture)
 * the drill step's own response is foldable on its own terms but is ALSO
 * depended on by a further step whose response carries the real per-item
 * data. The primary item that threads the nested join is the SECOND item
 * (`sku-b`), not the first, so `primaryMatchedItemIndex` must resolve by
 * walking into each item's nested fields rather than assuming index 0, while
 * `computeFoldChain` must still extend the chain past the drill step to its
 * dependent follow-up rather than stopping at the drill step's own array.
 */
export function buildMulticallSingleShotSearchDrillDownNestedJoinFieldChainedDependentActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ identifiers: { sku: "sku-a" } }, { identifiers: { sku: "sku-b" } }],
      },
      timestamp: "2024-11-20T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-b"}',
      responseBody: {
        priceToken: "tok-b1",
        prices: [{ sku: "sku-b", amount: 24.99 }],
      },
      timestamp: "2024-11-20T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_PRICE_HISTORY_URL,
      requestPostData: '{"priceToken":"tok-b1"}',
      responseBody: {
        history: [{ sku: "sku-b", amount: 22.5, asOf: "2024-11-01" }],
      },
      timestamp: "2024-11-20T00:00:02Z",
    }),
  ];
}

/**
 * A search endpoint re-queried with two distinct bodies (`page 1`/`page 2`,
 * satisfying {@link findRequeriedActions}'s re-query signature) whose
 * responses BOTH independently contain a `results[]` item sharing the same
 * `sku` — but at a different `price` (10 vs 12) — followed by a pricing
 * drill-down call threading that `sku` via its URL query param. Every prior
 * action is a fold-primary candidate for {@link detectDrillDownFoldPlan}, so
 * both step 0 and step 1 satisfy the drill's join; the primary-candidate
 * scan currently commits to the FIRST match (step 0, `price: 10`) and
 * globally consumes the drill step, so step 1 — the fresher, `price: 12`
 * re-queried occurrence — is never considered. `amount` in the drill
 * response is the object-array field distinct from `price` that a fold
 * assertion reads to observe which occurrence was actually folded onto.
 */
export function buildMulticallSingleShotSearchDrillDownRequeriedPrimaryOverlapActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a", price: 10 }],
      },
      timestamp: "2024-12-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":2}',
      responseBody: {
        results: [{ sku: "sku-a", price: 12 }],
      },
      timestamp: "2024-12-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: `${CATALOG_PRICING_URL}?sku=sku-a`,
      requestPostData: null,
      responseBody: {
        prices: [{ sku: "sku-a", amount: 19.99 }],
      },
      timestamp: "2024-12-01T00:00:02Z",
    }),
  ];
}

const CATALOG_VENDOR_DETAIL_URL = "https://api.example.com/catalog/vendors/detail/";

/**
 * A single primary search response carrying TWO genuinely independent
 * object-array fields — `products[]` and `vendors[]` — each drilled by its
 * own, unrelated later step (`sku` into a pricing lookup, `vendorId` into a
 * vendor-detail lookup). `scanPrimaryCandidate`'s old candidatePool lock
 * (recon-generate.ts:5411-5413) resolved only whichever array its FIRST
 * qualifying drill-down threaded from (`products[]`, via r1) and then
 * restricted every later candidate scan to that SAME array, so r2's
 * `vendorId` thread into `vendors[]` was silently discarded — this fixture
 * proves BOTH arrays fold independently, one FoldPlan per distinct
 * `primaryArrayPath`.
 */
export function buildMulticallSingleShotSearchTwoIndependentArraysActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        products: [{ sku: "sku-a" }],
        vendors: [{ vendorId: "v1" }],
      },
      timestamp: "2025-01-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${CATALOG_PRICING_URL}?sku=sku-a`,
      requestPostData: null,
      responseBody: {
        prices: [{ sku: "sku-a", amount: 9.99 }],
      },
      timestamp: "2025-01-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: `${CATALOG_VENDOR_DETAIL_URL}?vendorId=v1`,
      requestPostData: null,
      responseBody: {
        contracts: [{ vendorId: "v1", contractId: "c1" }],
      },
      timestamp: "2025-01-01T00:00:02Z",
    }),
  ];
}

/**
 * A single primary search response carrying TWO independent object-array
 * fields — `products[]`, whose `sku` join threads through the pricing call's
 * own JSON body and so is structurally detectable, and `vendors[]`, whose
 * `vendorId` join threads ONLY through the vendor-detail call's
 * `X-Vendor-Id` request header, invisible to `collectRequestStringValues`
 * and resolvable only via a flow-declared `foldReturn` spec naming `vendors`
 * as its `resultsPath`. `mergeSpecPlanOntoSamePrimary` used to key its
 * consumed-index check off `primaryStepIndex` alone, so the spec's plan —
 * anchored on the SAME step 0 the structural heuristic had already resolved,
 * but naming a DIFFERENT array — was wrongly treated as already consumed and
 * silently dropped instead of appended.
 */
export function buildMulticallStructuralPlusSpecOnlySameStepActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        products: [{ sku: "sku-a" }],
        vendors: [{ vendorId: "v1" }],
      },
      timestamp: "2025-03-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${CATALOG_PRICING_URL}?sku=sku-a`,
      requestPostData: null,
      responseBody: {
        prices: [{ sku: "sku-a", amount: 9.99 }],
      },
      timestamp: "2025-03-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_VENDOR_DETAIL_URL,
      requestPostData: '{"lookup":true}',
      responseBody: {
        contracts: [{ vendorId: "v1", contractId: "c1" }],
      },
      timestamp: "2025-03-01T00:00:02Z",
      requestHeaders: { "Content-Type": "application/json", "X-Vendor-Id": "v1" },
    }),
  ];
}

const ORDER_HISTORY_URL = "https://api.example.com/orders/history/";

/**
 * A 3-step chain where the drill step (`r1`) is a bare threading step — its
 * response carries the join value (`statusToken`) but no object-array field
 * at all, so it can't itself be the decoy. The decoy instead sits on the
 * chain's terminal step (`r2`): a `warnings[]` array positioned BEFORE the
 * real per-item `entries[]` array in key order, where `entries[]`'s items
 * thread `r2`'s own `statusToken` request value and `warnings[]`'s items do
 * not. {@link computeFoldChain}'s `selectDisambiguatedCandidate` call on
 * this (non-immediate) chain hop must resolve `chainArrayPath` to `entries`
 * on the threaded-join-fields match, not `warnings` for being found first.
 */
export function buildMulticallSingleShotSearchDrillDownChainedDecoyOnChainTerminalActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: "order-7" }],
      },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/orders/order-7/status",
      requestPostData: null,
      responseBody: {
        statusToken: "tok-99",
      },
      timestamp: "2024-09-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_URL,
      requestPostData: '{"statusToken":"tok-99"}',
      responseBody: {
        warnings: [{ code: "stale-cache" }],
        entries: [{ statusToken: "tok-99", ts: "2024-09-01T00:00:02Z", event: "shipped" }],
      },
      timestamp: "2024-09-01T00:00:02Z",
    }),
  ];
}

const CATALOG_ORDER_STATUS_URL = "https://api.example.com/catalog/order-status";

/**
 * A single-shot search → per-item drill-down flow where the drill step's
 * OWN response (`r1`) is entirely OPAQUE — a bare array holding a single
 * token, satisfying neither `isObjectArrayItem` nor
 * `findAllObjectArrayFields`, so `selectDisambiguatedCandidate` finds no
 * candidate there at all — and is depended on by a THIRD step (`r2`) whose
 * response carries the real per-item array this flow means to fold. Unlike
 * {@link buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps},
 * whose `r1` is ALSO independently foldable, this fixture isolates the case
 * where `computeFoldChain` has nothing to fall back on at the immediate hop
 * and must extend the chain past it to `r2` to find any candidate at all.
 */
export function buildMulticallSingleShotSearchDrillDownOpaqueIntermediateChainedDependentActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: "order-a" }, { orderId: "order-b" }],
      },
      timestamp: "2024-10-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_ORDER_STATUS_URL,
      requestPostData: '{"orderId":"order-a"}',
      responseBody: ["status-token-order-a"],
      timestamp: "2024-10-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_URL,
      requestPostData: '{"statusToken":"status-token-order-a"}',
      responseBody: {
        entries: [
          { statusToken: "status-token-order-a", ts: "2024-10-01T00:00:02Z", event: "shipped" },
        ],
      },
      timestamp: "2024-10-01T00:00:02Z",
    }),
  ];
}

/**
 * A 4-step sibling of
 * {@link buildMulticallSingleShotSearchDrillDownOpaqueIntermediateChainedDependentActionSteps}
 * that inserts one more chain hop between the opaque token step and the real
 * per-item terminal: a flat confirmation object (`r2`) that echoes back the
 * token it was called with (excluded from its richness by
 * `directPrimitiveChildCountExcludingEchoed`) alongside a boolean status flag
 * AND a second, non-echoed token that threads onward into the real terminal
 * step (`r3`). Both `r2` and `r3` land on the SAME richness — two non-echoed
 * primitive fields apiece (`held`/`receiptToken` on `r2`, `event`/`ts` on
 * `r3`) — so `computeFoldChain`'s strict `candidateRichness > chainTerminalRichness`
 * comparison never lets `r3` displace `r2` as the chain terminal: a tie is
 * exactly as "not richer" as a loss. This isolates the case where a
 * side-effect confirmation hop that merely happens to match the real
 * terminal's field count silently masks it, as opposed to
 * {@link buildMulticallSingleShotSearchDrillDownOpaqueIntermediateChainedDependentActionSteps}'s
 * opaque hop, which offers no candidate at all.
 */
export function buildMulticallSingleShotSearchDrillDownRichnessTiedConfirmationHopChainedDependentActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: "order-a" }, { orderId: "order-b" }],
      },
      timestamp: "2024-10-02T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_ORDER_STATUS_URL,
      requestPostData: '{"orderId":"order-a"}',
      responseBody: ["status-token-order-a"],
      timestamp: "2024-10-02T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_URL,
      requestPostData: '{"statusToken":"status-token-order-a"}',
      responseBody: {
        statusToken: "status-token-order-a",
        held: true,
        receiptToken: "receipt-token-order-a",
      },
      timestamp: "2024-10-02T00:00:02Z",
    }),
    buildStep("r3", {
      url: `${ORDER_HISTORY_URL}receipt/`,
      requestPostData: '{"receiptToken":"receipt-token-order-a"}',
      responseBody: {
        entries: [
          {
            receiptToken: "receipt-token-order-a",
            event: "shipped",
            ts: "2024-10-02T00:00:03Z",
          },
        ],
      },
      timestamp: "2024-10-02T00:00:03Z",
    }),
  ];
}

const ORDER_HISTORY_BULK_URL = "https://api.example.com/orders/history/bulk";

/**
 * An array-wrapped sibling of
 * {@link buildMulticallSingleShotSearchDrillDownOpaqueIntermediateChainedDependentActionSteps}:
 * the opaque intermediate hop (`r1`) is identical, but the chain's TERMINAL
 * hop (`r2`) threads `r1`'s produced `statusToken` wrapped inside a
 * single-element request-body ARRAY (`{"tokens":["status-token-order-a"]}`,
 * a bulk/batch-lookup request shape) instead of as a flat top-level scalar
 * field. `computeFoldChain`'s structural `dependsOnChain` detection (which
 * walks every request-body leaf regardless of nesting) resolves the chain
 * correctly either way, so this isolates a DIFFERENT failure: the
 * request-body render must still be able to thread `statusToken` into that
 * array slot instead of freezing the whole array as an opaque caller-payload
 * blob (`applyStructuredValuePayloadSubstitutions`'s "swallow whole
 * caller-supplied array/object" mechanism, which runs BEFORE state
 * threading and has no concept of "this array actually wraps a threaded
 * dependent-drill-down join value").
 */
export function buildMulticallSingleShotSearchDrillDownArrayWrappedChainedDependentActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: "order-a" }, { orderId: "order-b" }],
      },
      timestamp: "2024-10-03T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_ORDER_STATUS_URL,
      requestPostData: '{"orderId":"order-a"}',
      responseBody: ["status-token-order-a"],
      timestamp: "2024-10-03T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_BULK_URL,
      requestPostData: '{"tokens":["status-token-order-a"]}',
      responseBody: {
        entries: [
          { statusToken: "status-token-order-a", ts: "2024-10-03T00:00:02Z", event: "shipped" },
        ],
      },
      timestamp: "2024-10-03T00:00:02Z",
    }),
  ];
}

/**
 * Same array-wrapped-chained shape as
 * {@link buildMulticallSingleShotSearchDrillDownArrayWrappedChainedDependentActionSteps},
 * but the chain-produced value threaded from `r1` into `r2` is a bare JSON
 * NUMBER (`12345678`) rather than a string. Unlike the primary-item join
 * field covered by
 * {@link buildMulticallSingleShotSearchDrillDownArrayWrappedNumericImmediateJoinFieldActionSteps},
 * a chain-produced value must first be indexed as a threadable STATE value by
 * `indexStateValues` before any array-wrap rendering question can even arise
 * — and `indexStateValues` walks response bodies via `walkStringLeaves`,
 * which yields string leaves only. A bare-number response leaf is therefore
 * never indexed and never appears in `compileActionSteps`' `produces[]` at
 * all, so `r2`'s templated body has no accessor to substitute and renders
 * `{"tokens":[undefined]}` — invalid JSON, thrown as a fetch failure. This is
 * a distinct, more fundamental gap than the array-wrap fix
 * (`applyStructuredValuePayloadSubstitutions`, bugfix-001) addresses: it sits
 * upstream, in state INDEXING, not in payload-substitution SPARING, and
 * reproduces identically whether or not the terminal body is array-wrapped.
 */
export function buildMulticallSingleShotSearchDrillDownArrayWrappedNumericChainedJoinFieldActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: "order-a" }, { orderId: "order-b" }],
      },
      timestamp: "2024-10-03T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_ORDER_STATUS_URL,
      requestPostData: '{"orderId":"order-a"}',
      responseBody: [12345678],
      timestamp: "2024-10-03T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_BULK_URL,
      requestPostData: '{"tokens":[12345678]}',
      responseBody: {
        entries: [{ statusToken: 12345678, ts: "2024-10-03T00:00:02Z", event: "shipped" }],
      },
      timestamp: "2024-10-03T00:00:02Z",
    }),
  ];
}

/**
 * A different sibling of the same array-wrapped-join-field failure family:
 * here it's the IMMEDIATE drill step (`r1`), not a later chain hop, whose
 * request body wraps the value it threads — but that value is the PRIMARY
 * ITEM's own join field (`orderId`), not a prior step's produced response
 * value. `applyStructuredValuePayloadSubstitutions`'s "spare a candidate
 * already threaded" exception only recognized prior-step state values, so it
 * still froze `r1`'s `{"orderIds":["order-a"]}` into an opaque
 * `${JSON.stringify(payload.orderIds)}` blob, destroying the literal
 * `"order-a"` text the fold-loop's own per-item `parameterize` pass (which
 * runs even later, once rendering enters the loop) needs to find and swap
 * for `${item.orderId}` — every iteration replayed the SAME captured order
 * instead of each primary item's own.
 */
export function buildMulticallSingleShotSearchDrillDownArrayWrappedImmediateJoinFieldActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: "order-a" }, { orderId: "order-b" }],
      },
      timestamp: "2024-10-03T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_ORDER_STATUS_URL,
      requestPostData: '{"orderIds":["order-a"]}',
      responseBody: ["status-token-order-a"],
      timestamp: "2024-10-03T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_BULK_URL,
      requestPostData: '{"tokens":["status-token-order-a"]}',
      responseBody: {
        entries: [
          { statusToken: "status-token-order-a", ts: "2024-10-03T00:00:02Z", event: "shipped" },
        ],
      },
      timestamp: "2024-10-03T00:00:02Z",
    }),
  ];
}

/**
 * Same array-wrapped-immediate-join-field shape as
 * {@link buildMulticallSingleShotSearchDrillDownArrayWrappedImmediateJoinFieldActionSteps},
 * but the primary item's join field is a bare JSON NUMBER (`orderId: 101`)
 * rather than a string. `walkStringLeaves` (used by the spare check in
 * `applyStructuredValuePayloadSubstitutions`) silently skips number leaves,
 * so a numeric join value wrapped in `{"orderIds":[101]}` was frozen into an
 * opaque `${JSON.stringify(payload.orderIds)}` blob instead of being spared
 * for the fold-loop's later per-item `parameterize` pass.
 */
export function buildMulticallSingleShotSearchDrillDownArrayWrappedNumericImmediateJoinFieldActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: 101 }, { orderId: 102 }],
      },
      timestamp: "2024-10-03T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_ORDER_STATUS_URL,
      requestPostData: '{"orderIds":[101]}',
      responseBody: ["status-token-101"],
      timestamp: "2024-10-03T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_BULK_URL,
      requestPostData: '{"tokens":["status-token-101"]}',
      responseBody: {
        entries: [
          { statusToken: "status-token-101", ts: "2024-10-03T00:00:02Z", event: "shipped" },
        ],
      },
      timestamp: "2024-10-03T00:00:02Z",
    }),
  ];
}

const ACCOUNT_STATUS_URL = "https://api.example.com/accounts/status";
const ACCOUNT_TRANSACTIONS_URL = "https://api.example.com/accounts/transactions";

/**
 * A dependent (chained) drill-down whose join key is threaded ONLY through a
 * request HEADER (`API-Token`) on the chain's ENTRY hop (`r1`) — invisible to
 * `detectDrillDownFoldPlan`'s structural heuristic exactly like
 * {@link buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps}
 * — so only a flow-declared `foldReturn` can resolve this fold at all. Unlike
 * every existing header-threaded-join fixture, though, a site author writing
 * that `foldReturn` naturally points `endpointPattern` at `r2`
 * (`/accounts/transactions`) — the call whose OWN response actually carries
 * the per-item data (`transactions[]`) they want folded — not at `r1`
 * (`/accounts/status`), the opaque intermediate hop that merely carries the
 * `accountId`→`API-Token` header thread onward as a `statusToken`. `r2`'s own
 * request only ever carries that threaded `statusToken`, never `accountId`
 * in any form (body, URL, or header) — the join key is resolvable only by
 * walking back to `r1`, exactly the way `computeFoldChain` already walks
 * FORWARD from a resolved entry hop to a richer terminal. `resultsPath`
 * anchors on `accounts`, `joinFields` on `accountId`.
 */
export function buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinChainedDependentActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: ACCOUNT_SEARCH_URL,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: {
        accounts: [
          { accountId: 42, name: "Acme" },
          { accountId: 43, name: "Globex" },
        ],
      },
      timestamp: "2024-08-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: ACCOUNT_STATUS_URL,
      requestPostData: null,
      requestHeaders: { "Content-Type": "application/json", "API-Token": "42" },
      responseBody: { statusToken: "status-token-42" },
      timestamp: "2024-08-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: ACCOUNT_TRANSACTIONS_URL,
      requestPostData: JSON.stringify({ statusToken: "status-token-42" }),
      responseBody: {
        transactions: [{ statusToken: "status-token-42", transactionId: "t-42", amount: 19.99 }],
      },
      timestamp: "2024-08-01T00:00:02Z",
    }),
  ];
}
