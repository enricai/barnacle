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
