import { addSeconds } from "date-fns";
import type { FoldReturnSpec } from "@/scripts/recon-generate";
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
  responseHeaders?: Record<string, string>;
  method?: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: overrides.method ?? "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: overrides.requestHeaders ?? { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: overrides.responseHeaders ?? { "content-type": "application/json" },
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
    responseHeaders?: Record<string, string>;
    method?: string;
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
 * A shared-key/different-shape sibling of
 * {@link buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps}: the
 * primary item and the drill-down response both carry a `fees` field, but
 * with incompatible shapes (`{ value }` on the primary vs `{ amount, total }`
 * on the drill). Proves the fold merge preserves the primary's own `fees`
 * value instead of letting the drill's differently-shaped `fees` clobber it.
 */
export function buildMulticallSingleShotSearchDrillDownSharedKeyDifferentShapeActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a", fees: { value: 5 } }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: {
        prices: [{ sku: "sku-a", amount: 19.99, fees: { amount: 2, total: 21.99 } }],
      },
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

const CATALOG_ENTRY_DETAILS_URL = "https://api.example.com/catalog/entries/details";

/**
 * A grouped, nested-primary drill-down whose drilled endpoint requires TWO
 * threaded params at once: the PARENT group's own `id` (a field that lives
 * one level above the nested items and is unreachable once
 * {@link pathToFoldAccessorExpr} `.flatMap`s the outer array away) and the
 * matched ITEM's own `date` (an ordinary leaf on the nested object itself).
 * The drilled entry's own `entryId` rides along as a THIRD query param (not
 * a URL path segment, so every drill capture shares one `endpointKey` — see
 * below) purely so a caller resolving this fixture against an explicit
 * `resultsPath: "sections.*.entries"` foldReturn spec has a join value to
 * bind the drill onto its OWN matched entry.
 *
 * `r2` is a decoy: same drilled pathname, but every one of its own param
 * values (`entryId`/`groupId`/`itemDate`) is foreign to the primary
 * response, so neither the structural heuristic nor a `joinFields:
 * ["entryId"]` spec ever threads a target onto it — it exists solely so
 * `findFrozenVaryingDrillParams`'s same-endpoint variance check (keyed on
 * `endpointKey`, i.e. origin+pathname, not query) has a second, genuinely
 * differing capture to compare `groupId`/`itemDate` against, proving the
 * hard-fail guard actually has something to catch if either param were
 * emitted as a literal instead of threaded off its own (item or ancestor)
 * binding:
 *
 * | capture | entryId       | groupId         | itemDate     |
 * | ------- | ------------- | --------------- | ------------ |
 * | r1      | e1            | sec1            | 2024-01-01   |
 * | r2      | zzz-unrelated | zzz-unrelated-g | 1900-01-01   |
 *
 * A fold plan that only threads the item-level `date` (dropping `groupId`
 * because it flatMaps away with the parent) would produce a drill URL
 * missing `groupId` entirely, or one frozen to whichever group was matched
 * during detection.
 */
export function buildMulticallNestedGroupedDrillDownTwoScopeParamsActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SECTIONS_URL,
      requestPostData: null,
      responseBody: {
        sections: [
          {
            id: "sec1",
            entries: [{ entryId: "e1", name: "Widget", date: "2024-01-01" }],
          },
          {
            id: "sec2",
            entries: [{ entryId: "e2", name: "Gadget", date: "2024-02-01" }],
          },
        ],
      },
      timestamp: "2024-12-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${CATALOG_ENTRY_DETAILS_URL}?entryId=e1&groupId=sec1&itemDate=2024-01-01`,
      requestPostData: null,
      responseBody: { details: [{ entryId: "e1", description: "A widget." }] },
      timestamp: "2024-12-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: `${CATALOG_ENTRY_DETAILS_URL}?entryId=zzz-unrelated&groupId=zzz-unrelated-g&itemDate=1900-01-01`,
      requestPostData: null,
      responseBody: { details: [] },
      timestamp: "2024-12-01T00:00:02Z",
    }),
  ];
}

/**
 * A grouped, nested-primary drill-down whose drilled endpoint needs ONLY the
 * PARENT group's `id` — never any field on the nested item itself. Each
 * group carries >=3 items so a per-group drill (one fetch, reused by every
 * item) is distinguishable at runtime from a per-item drill (one fetch per
 * item). The drilled endpoint returns the WHOLE group's entries in one
 * response (keyed by `entryId`), mirroring a real ancestor-scoped drill that
 * fetches "everything for this group" rather than one row per item — so the
 * join still resolves each item's own fields from a single per-group
 * response.
 *
 * `r1` is the real drill (matches group `sec1` via its response's
 * `entryId`s). `r2` is a decoy — same drilled pathname, but its `groupId`
 * and every `details` entryId are foreign to the primary response — so
 * {@link findFrozenVaryingDrillParams}'s same-endpoint variance check has a
 * second, genuinely differing capture to compare `groupId` against, proving
 * the hard-fail guard actually has something to catch if it were emitted as
 * a literal instead of threaded off the ancestor binding, while still
 * leaving exactly one REAL, resolvable target for the fold plan (mirroring
 * {@link buildMulticallNestedGroupedDrillDownTwoScopeParamsActionSteps}'s
 * own real/decoy split).
 */
export function buildMulticallNestedGroupedDrillDownAncestorOnlyParamsActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SECTIONS_URL,
      requestPostData: null,
      responseBody: {
        sections: [
          {
            id: "sec1",
            entries: [
              { entryId: "e1", name: "Widget" },
              { entryId: "e2", name: "Gadget" },
              { entryId: "e3", name: "Doohickey" },
            ],
          },
          {
            id: "sec2",
            entries: [
              { entryId: "e4", name: "Thingamajig" },
              { entryId: "e5", name: "Contraption" },
              { entryId: "e6", name: "Gizmo" },
            ],
          },
        ],
      },
      timestamp: "2025-01-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${CATALOG_ENTRY_DETAILS_URL}?groupId=sec1`,
      requestPostData: null,
      responseBody: {
        details: [
          { entryId: "e1", description: "A widget." },
          { entryId: "e2", description: "A gadget." },
          { entryId: "e3", description: "A doohickey." },
        ],
      },
      timestamp: "2025-01-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: `${CATALOG_ENTRY_DETAILS_URL}?groupId=zzz-unrelated-g`,
      requestPostData: null,
      responseBody: {
        details: [{ entryId: "zzz-unrelated", description: "An unrelated entry." }],
      },
      timestamp: "2025-01-01T00:00:02Z",
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
 * A response-header sibling of {@link buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps}:
 * the drill step's (`r1`) response mints its join token (`tok-a1`) ONLY in a
 * custom response HEADER (`X-Price-Token`) — its body is empty, unlike the
 * sibling's `priceToken` body field. A third step (`r2`) threads that header
 * value into its own request body and carries the real per-item `history[]`
 * array. `computeFoldChain`'s `dependsOnChain` check must walk `r1`'s
 * response headers (not just its body) to see the shared value, extending
 * the chain to `[drillStepIndex, historyStepIndex]` rather than stopping at
 * `r1`.
 */
export function buildMulticallSingleShotSearchDrillDownHeaderMintedChainedResponseValueActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-11-16T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: {},
      responseHeaders: { "content-type": "application/json", "X-Price-Token": "tok-a1" },
      timestamp: "2024-11-16T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_PRICE_HISTORY_URL,
      requestPostData: '{"priceToken":"tok-a1"}',
      responseBody: {
        history: [{ sku: "sku-a", amount: 18.5, asOf: "2024-11-01" }],
      },
      timestamp: "2024-11-16T00:00:02Z",
    }),
  ];
}

const CATALOG_VERIFICATION_STATUS_URL = "https://api.example.com/catalog/verification-status";

/**
 * A boolean-threading sibling of {@link buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps}:
 * the drill step's (`r1`) response mints ONLY a boolean value
 * (`{ verified: true }`) and carries no array of its own — unlike the
 * `priceToken`/`prices[]` sibling, this drill step is NOT foldable in
 * isolation. A third step (`r2`) threads that boolean (rendered as the
 * string `"true"`) into its request and carries the real per-item
 * `history[]` array in its response. `computeFoldChain` must recognize the
 * boolean leaf as a genuine chain-dependency source and extend the chain to
 * `[drillStepIndex, historyStepIndex]` rather than stopping at `r1`.
 */
export function buildMulticallSingleShotSearchDrillDownBooleanChainedResponseValueActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-12-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: {
        verified: true,
      },
      timestamp: "2024-12-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_VERIFICATION_STATUS_URL,
      requestPostData: '{"verified":"true"}',
      responseBody: {
        history: [{ sku: "sku-a", amount: 18.5, asOf: "2024-11-01" }],
      },
      timestamp: "2024-12-01T00:00:02Z",
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
 * A sibling of
 * {@link buildMulticallSingleShotSearchDrillDownArrayWrappedNumericChainedJoinFieldActionSteps}
 * isolating a DIFFERENT gap in the numeric chain-produced join field family:
 * `r1`'s produced token is a bare (non-array-wrapped) JSON number, and — the
 * shape that matters here — it is SHORT (`42`/`43`, two digits) rather than
 * an 8-digit token. `indexStateValues` gates every candidate state value on
 * `MIN_STATE_VALUE_LENGTH` (8 chars), a threshold sized to keep an unrelated
 * short STRING (an enum code, a page number) from colliding with arbitrary
 * substrings elsewhere; applied uniformly to a bare NUMBER's stringified
 * length, it also silently excludes a short numeric id/token — exactly the
 * common shape for an order/account/status id — from ever being indexed as
 * producible state. Without that index entry, `compileActionSteps` never
 * emits a `produces[]` accessor for `r1`'s response, so `r2`'s templated
 * body has nothing to substitute and falls back to treating `{"token":...}`
 * as an opaque caller-supplied payload field (`payload.token`) instead of
 * the per-item threaded value — every iteration would send whatever (or
 * nothing) the caller passed, not each primary item's own token.
 */
export function buildMulticallSingleShotSearchDrillDownShortNumericChainedJoinFieldActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: "order-a" }, { orderId: "order-b" }],
      },
      timestamp: "2024-10-04T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_ORDER_STATUS_URL,
      requestPostData: '{"orderId":"order-a"}',
      responseBody: [42],
      timestamp: "2024-10-04T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_URL,
      requestPostData: '{"token":42}',
      responseBody: {
        entries: [{ token: 42, ts: "2024-10-04T00:00:02Z", event: "shipped" }],
      },
      timestamp: "2024-10-04T00:00:02Z",
    }),
  ];
}

/**
 * Cookie-origin sibling of
 * {@link buildMulticallSingleShotSearchDrillDownShortNumericChainedJoinFieldActionSteps}:
 * here `r1` mints the short chain-produced token (`tok1`, under
 * `MIN_STATE_VALUE_LENGTH`) via `Set-Cookie` rather than the response body,
 * AND echoes the same value in its response body (the "body-level echo" that
 * lets {@link collectDependentDrillDownChainValues} confirm the cookie value
 * is chain-produced, exactly as a body-sourced token would be). `r2` threads
 * `tok1` back via its request body. Exercises `indexStateValues`' Set-Cookie
 * branch's `chainForceIncludeValues`/`forceIncludeValues` exemption, mirroring
 * the body-value floor exemption.
 */
export function buildMulticallSingleShotSearchDrillDownShortCookieChainedJoinFieldActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: "order-a" }, { orderId: "order-b" }],
      },
      timestamp: "2024-10-05T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_ORDER_STATUS_URL,
      requestPostData: '{"orderId":"order-a"}',
      responseHeaders: { "set-cookie": "sess=tok1; Path=/; HttpOnly" },
      responseBody: { echoedToken: "tok1" },
      timestamp: "2024-10-05T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_URL,
      requestPostData: '{"token":"tok1"}',
      responseBody: {
        entries: [{ token: "tok1", ts: "2024-10-05T00:00:02Z", event: "shipped" }],
      },
      timestamp: "2024-10-05T00:00:02Z",
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

/**
 * Same array-wrapped-immediate-join-field shape as
 * {@link buildMulticallSingleShotSearchDrillDownArrayWrappedNumericImmediateJoinFieldActionSteps},
 * but the primary item's join field is a bare JSON BOOLEAN (`flag: true`)
 * rather than a number or string. `walkStringLeaves` (used by the spare
 * check in `applyStructuredValuePayloadSubstitutions`) silently skips
 * boolean leaves the same way it skips number leaves, so a boolean join
 * value wrapped in `{"flags":[true]}` was frozen into an opaque
 * `${JSON.stringify(payload.flags)}` blob instead of being spared for the
 * fold-loop's later per-item `parameterize` pass.
 */
export function buildMulticallSingleShotSearchDrillDownArrayWrappedBooleanImmediateJoinFieldActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ flag: true }, { flag: false }],
      },
      timestamp: "2024-10-03T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_ORDER_STATUS_URL,
      requestPostData: '{"flags":[true]}',
      responseBody: ["status-token-true"],
      timestamp: "2024-10-03T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_HISTORY_BULK_URL,
      requestPostData: '{"tokens":["status-token-true"]}',
      responseBody: {
        entries: [
          { statusToken: "status-token-true", ts: "2024-10-03T00:00:02Z", event: "shipped" },
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

const ORDER_STATUS_LOOKUP_URL = "https://api.example.com/orders/status-lookup";
const ORDER_EVENTS_URL = "https://api.example.com/orders/events";

/**
 * A dependent (chained) drill-down whose ENTRY hop (`r1`) is a `GET`
 * request — not the `POST` every other chained-dependent fixture in this
 * file uses — and whose response produces the chain's join value
 * (`statusToken`) as a non-UUID string. `indexStateValues` indexes a `GET`
 * capture's response leaves ONLY when they are UUID-shaped
 * (`isGet && !UUID_REGEX.test(value)` skips everything else, a filter aimed
 * at excluding noisy short non-UUID strings a GET-only telemetry/schema
 * fetch surfaces); that filter runs unconditionally, with no exemption for a
 * value `collectDependentDrillDownChainValues` has already confirmed is
 * threaded from this exact hop into a later chain hop's own request — unlike
 * the `MIN_STATE_VALUE_LENGTH` floor a few lines above it, which DOES carry
 * that exemption. So a chain-produced token minted by a GET response is
 * never indexed as producible state at all, `compileActionSteps` never
 * emits a `produces[]` accessor for it, and `r2`'s templated body has
 * nothing to substitute — every iteration renders the literal string
 * `"undefined"` instead of threading each primary item's own token.
 */
export function buildMulticallSingleShotSearchDrillDownGetEntryHopChainedDependentActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ orderId: "order-a" }, { orderId: "order-b" }],
      },
      timestamp: "2024-10-05T00:00:00Z",
    }),
    buildStep("r1", {
      method: "GET",
      url: `${ORDER_STATUS_LOOKUP_URL}?orderId=order-a`,
      requestPostData: null,
      responseBody: { statusToken: "status-token-order-a" },
      timestamp: "2024-10-05T00:00:01Z",
    }),
    buildStep("r2", {
      url: ORDER_EVENTS_URL,
      requestPostData: '{"token":"status-token-order-a"}',
      responseBody: {
        entries: [{ token: "status-token-order-a", ts: "2024-10-05T00:00:02Z", event: "shipped" }],
      },
      timestamp: "2024-10-05T00:00:02Z",
    }),
  ];
}

/**
 * A response-header sibling of {@link buildMulticallSingleShotSearchDrillDownGetEntryHopChainedDependentActionSteps}:
 * the chain's drill hop (`r1`) mints its join token (`tok-a1`) ONLY in a
 * custom response HEADER (`X-Price-Token`) — its body is empty ({}), unlike
 * {@link buildMulticallSingleShotSearchDrillDownHeaderMintedChainedResponseValueActionSteps}'s
 * body-echo-free sibling, which threads the header value forward via the
 * request BODY. Here the terminal hop (`r2`) instead threads that value back
 * as a REQUEST HEADER of its own (also named `X-Price-Token`) — the only
 * shape `createHttpClient`'s `bind` option can actually thread a
 * header-origin value into, since the emitted response variable never
 * exposes response headers to the rest of the generated code. Exercises
 * `compileActionSteps`' non-cookie response-header produce block: without it,
 * `tok-a1` is never captured into a `produces[]`/`bind` entry at all, and
 * `r2`'s per-item call goes out with no `X-Price-Token` header, so the
 * terminal `history[]` fold silently collapses to whichever primary item the
 * stub happens to answer first instead of each item's own token.
 */
export function buildMulticallSingleShotSearchDrillDownResponseHeaderThreadedJoinChainedDependentActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "sku-a" }, { sku: "sku-b" }],
      },
      timestamp: "2024-12-10T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_PRICING_URL,
      requestPostData: '{"sku":"sku-a"}',
      responseBody: {},
      responseHeaders: { "content-type": "application/json", "X-Price-Token": "tok-a1" },
      timestamp: "2024-12-10T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_PRICE_HISTORY_URL,
      requestPostData: "{}",
      requestHeaders: { "Content-Type": "application/json", "X-Price-Token": "tok-a1" },
      responseBody: {
        history: [{ sku: "sku-a", amount: 18.5, asOf: "2024-11-01" }],
      },
      timestamp: "2024-12-10T00:00:02Z",
    }),
  ];
}

/**
 * The declared `foldReturn` matching {@link buildFoldReturnScalableActionSequence}'s
 * lone real primary/drill-down pair. The join value is threaded only through
 * a request HEADER (never the URL or body), mirroring the header-threaded
 * fixtures used elsewhere in this module — `detectDrillDownFoldPlan`'s
 * structural heuristic never scans headers, so resolving this pair is only
 * reachable through `buildFoldPlanFromSpec`, the exact code path the
 * incident's large-capture-set hang was traced to.
 */
export const FOLD_RETURN_SCALABLE_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  joinFields: ["sku"],
};

const FOLD_RETURN_SCALABLE_BASE_TIMESTAMP = new Date("2024-11-01T00:00:00.000Z");

/**
 * Generates `n` {@link MulticallFixtureStep} entries reproducing the reported
 * incident's shape at any scale: a large capture set dominated by noise
 * candidates, with exactly one primary/drill-down pair that actually
 * satisfies {@link FOLD_RETURN_SCALABLE_SPEC}. The real primary is placed
 * first and the real drill-down last, so every noise step sits between them
 * and `buildFoldPlanFromSpec`'s primary×drill scan has to walk the full
 * candidate set to find the one true match — the same "one eligible pair
 * buried among many candidates" shape the incident's 2000+-capture run hit.
 *
 * Noise steps alternate between two shapes that are each independently
 * eligible for one side of the scan without ever completing a match:
 * - a "noise primary" re-hitting the same search endpoint with its own
 *   unique `sku`, so `objectItemsAtPath` treats it as a valid primary
 *   candidate at every even noise slot;
 * - a "noise drill" re-hitting the same pricing endpoint (so it passes
 *   `compileFoldReturnEndpointMatcher`) with its own unique, non-matching
 *   `X-Item-Sku` header, so every real primary/noise-drill and noise-
 *   primary/real-drill combination is scanned and rejected.
 *
 * Since no noise step's join value ever matches another step's, none of
 * them can complete a fold — `resolveFoldPlan` still returns exactly the one
 * plan for the real pair, regardless of how large `n` is.
 */
export function buildFoldReturnScalableActionSequence(n: number): MulticallFixtureStep[] {
  if (n < 2) throw new Error(`buildFoldReturnScalableActionSequence requires n >= 2, got ${n}`);

  const timestampAt = (index: number): string =>
    addSeconds(FOLD_RETURN_SCALABLE_BASE_TIMESTAMP, index).toISOString();

  const realPrimary = buildStep("primary", {
    url: CATALOG_SEARCH_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ sku: "sku-real" }] },
    timestamp: timestampAt(0),
  });

  const realDrill = buildStep("drill", {
    url: CATALOG_PRICING_URL,
    requestPostData: '{"lookup":true}',
    responseBody: { prices: [{ sku: "sku-real", amount: 19.99 }] },
    timestamp: timestampAt(n - 1),
    requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-real" },
  });

  const noiseSteps: MulticallFixtureStep[] = Array.from({ length: n - 2 }, (_, i) => {
    const index = i + 1;
    return i % 2 === 0
      ? buildStep(`noise-primary-${i}`, {
          url: CATALOG_SEARCH_URL,
          requestPostData: `{"page":${index + 1}}`,
          responseBody: { results: [{ sku: `sku-noise-primary-${i}` }] },
          timestamp: timestampAt(index),
        })
      : buildStep(`noise-drill-${i}`, {
          url: CATALOG_PRICING_URL,
          requestPostData: '{"lookup":true}',
          responseBody: { prices: [{ sku: `sku-noise-drill-${i}`, amount: 9.99 }] },
          timestamp: timestampAt(index),
          requestHeaders: {
            "Content-Type": "application/json",
            "X-Item-Sku": `sku-noise-drill-${i}`,
          },
        });
  });

  return [realPrimary, ...noiseSteps, realDrill];
}

/**
 * A wildcard-`resultsPath` sibling of {@link FOLD_RETURN_SCALABLE_SPEC}: the
 * primary item lives under a single nested array-of-objects hop
 * (`groups.*.items`) rather than a flat top-level array, exercising
 * {@link objectItemsAtPath}'s `ARRAY_WILDCARD_SEGMENT` flatMap branch instead
 * of its flat-path branch. Pairs with
 * {@link buildFoldReturnWildcardScalableActionSequence}, which reproduces the
 * same "one real pair buried among many candidates" shape as
 * {@link buildFoldReturnScalableActionSequence} but with every primary's
 * items nested one `groups[]` level deep.
 */
export const FOLD_RETURN_WILDCARD_SCALABLE_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "groups.*.items",
  joinFields: ["sku"],
};

/**
 * Wildcard-`resultsPath` sibling of {@link buildFoldReturnScalableActionSequence}:
 * identical noise/real-pair shape and scale, except every primary response
 * (real and noise alike) nests its item under a single-element `groups[]`
 * array (`{ groups: [ { items: [...] } ] }`) instead of a flat top-level
 * array, so `objectItemsAtPath` must resolve {@link
 * FOLD_RETURN_WILDCARD_SCALABLE_SPEC}'s `groups.*.items` wildcard path
 * across the full candidate set rather than a flat `resultsPath`. Proves the
 * value-indexed pruning `buildFoldPlanFromSpec` relies on (keyed on join
 * VALUES, not on `resultsPath` shape) stays linear at scale under the
 * wildcard branch too.
 */
export function buildFoldReturnWildcardScalableActionSequence(n: number): MulticallFixtureStep[] {
  if (n < 2) {
    throw new Error(`buildFoldReturnWildcardScalableActionSequence requires n >= 2, got ${n}`);
  }

  const timestampAt = (index: number): string =>
    addSeconds(FOLD_RETURN_SCALABLE_BASE_TIMESTAMP, index).toISOString();

  const realPrimary = buildStep("primary", {
    url: CATALOG_SEARCH_URL,
    requestPostData: '{"page":1}',
    responseBody: { groups: [{ items: [{ sku: "sku-real" }] }] },
    timestamp: timestampAt(0),
  });

  const realDrill = buildStep("drill", {
    url: CATALOG_PRICING_URL,
    requestPostData: '{"lookup":true}',
    responseBody: { prices: [{ sku: "sku-real", amount: 19.99 }] },
    timestamp: timestampAt(n - 1),
    requestHeaders: { "Content-Type": "application/json", "X-Item-Sku": "sku-real" },
  });

  const noiseSteps: MulticallFixtureStep[] = Array.from({ length: n - 2 }, (_, i) => {
    const index = i + 1;
    return i % 2 === 0
      ? buildStep(`noise-primary-${i}`, {
          url: CATALOG_SEARCH_URL,
          requestPostData: `{"page":${index + 1}}`,
          responseBody: { groups: [{ items: [{ sku: `sku-noise-primary-${i}` }] }] },
          timestamp: timestampAt(index),
        })
      : buildStep(`noise-drill-${i}`, {
          url: CATALOG_PRICING_URL,
          requestPostData: '{"lookup":true}',
          responseBody: { prices: [{ sku: `sku-noise-drill-${i}`, amount: 9.99 }] },
          timestamp: timestampAt(index),
          requestHeaders: {
            "Content-Type": "application/json",
            "X-Item-Sku": `sku-noise-drill-${i}`,
          },
        });
  });

  return [realPrimary, ...noiseSteps, realDrill];
}

const CATALOG_ENTRY_LOOKUP_URL = "https://api.example.com/catalog/entry-lookup";

/**
 * A paginated primary — the SAME search endpoint captured twice (`r0`, `r1`)
 * with different request bodies, each returning a DIFFERENT single item —
 * followed by one drill call (`r2`) engineered so the structural heuristic
 * and a spec-declared `foldReturn` genuinely anchor on DIFFERENT captures of
 * that primary, not merely a different array on the SAME capture (that split
 * is {@link buildMulticallStructuralPlusSpecOnlySameStepActionSteps}'s case).
 * `r0`'s outer item carries a `flagged: true` boolean that also appears in
 * `r2`'s own request body, so the structural scan threads a join on that
 * boolean and anchors on `r0` (`primaryStepIndex 0`) — `r1`'s outer item
 * flips the SAME boolean to `false`, which never appears in `r2`'s request,
 * so `r1` contributes no competing structural candidate at all. A declared
 * spec naming the NESTED `entries[]` array (`resultsPath: "items.*.entries"`,
 * `joinFields: ["id"]`) fails to resolve against `r0` (its nested `id` is
 * `"e-shallow"`, absent from `r2`'s response) but succeeds against `r1`
 * (`id: "e1"` IS present in `r2`'s response `entries[]`), so the spec
 * resolver's own freshest-wins loop anchors on `r1` (`primaryStepIndex 1`)
 * instead. The two resolvers land on different CAPTURES of the identical
 * primary operation — proving the discard isn't limited to a single-capture,
 * same-step array mismatch.
 */
export function buildMulticallSingleShotSearchDrillDownNestedJoinFieldPaginatedPrimaryCaptureSplitActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        items: [{ itemId: "p0", flagged: true, entries: [{ id: "e-shallow", region: "north" }] }],
      },
      timestamp: "2025-06-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":2}',
      responseBody: {
        items: [{ itemId: "p1", flagged: false, entries: [{ id: "e1", region: "south" }] }],
      },
      timestamp: "2025-06-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: CATALOG_ENTRY_LOOKUP_URL,
      requestPostData: '{"flagged":true}',
      responseBody: {
        entries: [
          { id: "decoy", flagged: true },
          { id: "e1", flagged: true },
        ],
      },
      timestamp: "2025-06-01T00:00:02Z",
    }),
  ];
}

const CATALOG_ITEM_QUOTE_URL = "https://api.example.com/catalog/item-quote";

/**
 * A search → per-item drill-down flow whose drill request carries a `qty`
 * query param that is CONSTANT across every capture of that endpoint in the
 * run (`qty=0` on both items' own drill requests), while the SECOND item
 * also happens to carry a `discount` field that is `0` — the same literal
 * (the first item's own `discount`, `99`, never collides, proving the
 * coincidence is per-item, not a fixture-wide constant). Matching `qty`'s
 * literal `"0"` against the primary purely by value equality (the pre-fix
 * behavior) binds `qty` to `discount` for the second item specifically, so
 * its emitted call would read `qty=${item.discount}` instead of the true,
 * always-`0` `qty`. The item's own `itemId` still varies across both drill
 * requests (`i1`/`i2`), proving real per-item threading is unaffected.
 */
export function buildMulticallSingleShotSearchDrillDownConstantParamCoincidentValueActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [
          { itemId: "i1", discount: 99 },
          { itemId: "i2", discount: 0 },
        ],
      },
      timestamp: "2025-07-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${CATALOG_ITEM_QUOTE_URL}?itemId=i1&qty=0`,
      requestPostData: null,
      responseBody: { quotes: [{ itemId: "i1", price: 9.99 }] },
      timestamp: "2025-07-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: `${CATALOG_ITEM_QUOTE_URL}?itemId=i2&qty=0`,
      requestPostData: null,
      responseBody: { quotes: [{ itemId: "i2", price: 14.99 }] },
      timestamp: "2025-07-01T00:00:02Z",
    }),
  ];
}

/**
 * A single-shot sibling of
 * {@link buildMulticallSingleShotSearchDrillDownConstantParamCoincidentValueActionSteps}
 * with only ONE drill capture of the quote endpoint (not two): the search
 * response's sole item carries an unrelated `discount: 0` field, and that
 * item's own drill request carries a bound `qty=0` query param — the same
 * literal. With a second same-endpoint capture, {@link
 * collectRequestStringValues}'s `varies()` gate can exclude a param whose
 * value never differs across sibling captures; with only one capture,
 * `sameEndpointCaptures.length === 0` and `varies()` defaults to `true`,
 * letting the literal `0` into the coincidence-threading candidate set and
 * actually reproducing the reported bug (matching `qty`'s literal against
 * the primary's `discount` field purely by value equality, ahead of the
 * declared `drillParamBindings` override).
 */
export function buildMulticallSingleShotSearchDrillDownBoundConstantParamCoincidentValueActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: CATALOG_SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ itemId: "i1", discount: 0 }],
      },
      timestamp: "2025-08-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${CATALOG_ITEM_QUOTE_URL}?itemId=i1&qty=0`,
      requestPostData: null,
      responseBody: { quotes: [{ itemId: "i1", price: 9.99 }] },
      timestamp: "2025-08-01T00:00:01Z",
    }),
  ];
}
