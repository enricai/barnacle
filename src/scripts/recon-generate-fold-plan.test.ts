import { describe, expect, it } from "vitest";
import {
  detectDrillDownFoldPlan,
  type FoldPlan,
  type FoldReturnSpec,
  resolveFoldPlan,
} from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildMulticallNestedGroupedDrillDownMultiGroupActionSteps,
  buildMulticallSingleShotSearchDrillDownActionSteps,
  buildMulticallSingleShotSearchDrillDownArrayWrappedChainedDependentActionSteps,
  buildMulticallSingleShotSearchDrillDownArrayWrappedNumericImmediateJoinFieldActionSteps,
  buildMulticallSingleShotSearchDrillDownChainedDecoyOnChainTerminalActionSteps,
  buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps,
  buildMulticallSingleShotSearchDrillDownChainedDependentMultipartChainStepActionSteps,
  buildMulticallSingleShotSearchDrillDownCompositeNumericJoinActionSteps,
  buildMulticallSingleShotSearchDrillDownCompositeNumericJoinNonFirstItemActionSteps,
  buildMulticallSingleShotSearchDrillDownDrillDecoyActionSteps,
  buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps,
  buildMulticallSingleShotSearchDrillDownNestedJoinFieldActionSteps,
  buildMulticallSingleShotSearchDrillDownNestedJoinFieldChainedDependentActionSteps,
  buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps,
  buildMulticallSingleShotSearchDrillDownNonFirstItemSkuActionSteps,
  buildMulticallSingleShotSearchDrillDownNumericJoinActionSteps,
  buildMulticallSingleShotSearchDrillDownOpaqueIntermediateChainedDependentActionSteps,
  buildMulticallSingleShotSearchDrillDownOutOfOrderItemActionSteps,
  buildMulticallSingleShotSearchDrillDownPathThreadedJoinActionSteps,
  buildMulticallSingleShotSearchDrillDownRequeriedPrimaryOverlapActionSteps,
  buildMulticallSingleShotSearchDrillDownRicherFlatOutranksNestedArrayActionSteps,
  buildMulticallSingleShotSearchDrillDownRichnessTiedConfirmationHopChainedDependentActionSteps,
  buildMulticallSingleShotSearchTwoIndependentArraysActionSteps,
  buildStep,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/** `detectDrillDownFoldPlan` takes the unexported `ActionStep[]`; the shared
 * fixture's `MulticallFixtureStep` is structurally identical except for
 * `produces` (`unknown[]` vs. the real `Produce[]`, always empty here — the
 * detector never reads it), so a type-only cast through the detector's own
 * parameter type is safe. */
function detectAll(steps: MulticallFixtureStep[]): ReturnType<typeof detectDrillDownFoldPlan> {
  return detectDrillDownFoldPlan(steps as unknown as Parameters<typeof detectDrillDownFoldPlan>[0]);
}

/** Most callers in this file exercise a single primary/drill-down pair, so
 * this unwraps the detector's plural result to the one plan they assert
 * against (or `null` when none was found). */
function detect(steps: MulticallFixtureStep[]): FoldPlan | null {
  return detectAll(steps)[0] ?? null;
}

describe("detectDrillDownFoldPlan", () => {
  it("detects the available-products (requeried) + available-units drill-down, threaded on productId", () => {
    const plan = detect(buildMulticallHeterogeneousActionStepsWithDrillDown());

    expect(plan).not.toBeNull();
    expect(plan?.primaryArrayPath).toEqual(["products"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["productId"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(4);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["units"]);
    // Primary must be the requeried available-products/ step whose item
    // actually satisfies the join (r2), not the drill-down step itself.
    expect(plan?.primaryStepIndex).toBe(2);
  });

  it("anchors on the freshest re-queried primary occurrence when both independently satisfy the drill-down's join key", () => {
    const plan = detect(
      buildMulticallSingleShotSearchDrillDownRequeriedPrimaryOverlapActionSteps()
    );

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(1);
    expect(plan?.primaryArrayPath).toEqual(["results"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["sku"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(2);
    expect(plan?.targets[0]?.primaryMatchedItemIndex).toBe(0);
  });

  it("anchors on the freshest re-queried primary occurrence when both independently thread the same drill-down's join key", () => {
    const AVAILABLE_PRODUCTS_URL = "https://api.example.com/available-products/";
    const AVAILABLE_UNITS_URL = "https://api.example.com/available-units/";
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: AVAILABLE_PRODUCTS_URL,
        requestPostData: '{"page":1}',
        responseBody: { products: [{ productId: "p1" }] },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: AVAILABLE_PRODUCTS_URL,
        requestPostData: '{"page":2}',
        responseBody: { products: [{ productId: "p1" }] },
        timestamp: "2024-01-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: AVAILABLE_UNITS_URL,
        requestPostData: '{"productId":"p1"}',
        responseBody: { units: [{ unitId: "s1" }] },
        timestamp: "2024-01-01T00:00:02Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    // Both r0 and r1 independently thread productId "p1" into r2's drill-down
    // request; the plan must anchor on the LATER (freshest) occurrence, r1,
    // matching selectReturnAction/selectPayloadAction's freshest-wins
    // convention for re-queried primaries.
    expect(plan?.primaryStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillStepIndex).toBe(2);
  });

  it("returns null for a plain 2-step submission flow with no array-index-threaded request", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/orders/create",
        requestPostData: JSON.stringify({ cartId: "cart-9" }),
        responseBody: { orderId: "order-42" },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/orders/order-42/confirm",
        requestPostData: JSON.stringify({ confirm: true }),
        responseBody: { orderId: "order-42", status: "confirmed" },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];

    expect(detect(steps)).toBeNull();
  });

  it("returns null when the requeried endpoint has no later step that threads a value from its array", () => {
    const plan = detect(buildMulticallHeterogeneousActionSteps());

    expect(plan).toBeNull();
  });

  it("detects a single-shot (non-requeried) search as a fold primary when its results array is the only object-array field", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.primaryArrayPath).toEqual(["results"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["sku"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["prices"]);
  });

  it("prefers a richer flat whole-object drill candidate over a small real nested object-array field", () => {
    const plan = detect(
      buildMulticallSingleShotSearchDrillDownRicherFlatOutranksNestedArrayActionSteps()
    );

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.drillArrayPath).toEqual([]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual([]);
  });

  it("resolves a fold plan when the drill step's response is a single flat object, not wrapped in an object-array field", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/search-results",
        requestPostData: null,
        responseBody: { results: [{ sku: "sku-1" }, { sku: "sku-2" }] },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/results/sku-2",
        requestPostData: null,
        responseBody: { sku: "sku-2", price: 42 },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.primaryArrayPath).toEqual(["results"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["sku"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillArrayPath).toEqual([]);
    expect(plan?.targets[0]?.primaryMatchedItemIndex).toBe(1);
    expect(plan?.targets[0]?.chainArrayPath).toEqual([]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(1);
  });

  it("resolves a fold plan and records the matched item's index when the drilled item is not first", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownOutOfOrderItemActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.primaryArrayPath).toEqual(["results"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["itemId"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["prices"]);
    expect(plan?.targets[0]?.primaryMatchedItemIndex).toBe(1);
  });

  it("resolves a fold plan when the sole captured drill-down call threads the second (not first) item's sku", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownNonFirstItemSkuActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.primaryArrayPath).toEqual(["results"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["sku"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["prices"]);
  });

  it("resolves a fold plan with a composite join key when the sole captured drill-down call threads the second (not first) item's key", () => {
    const plan = detect(
      buildMulticallSingleShotSearchDrillDownCompositeNumericJoinNonFirstItemActionSteps()
    );

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.primaryArrayPath).toEqual(["accounts"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["region", "accountId"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["transactions"]);
  });

  it("resolves a numeric-typed join field threaded via a URL query param", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownNumericJoinActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.joinFields).toEqual(["accountId"]);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["transactions"]);
  });

  it("resolves a numeric-typed join field threaded via a JSON body literal", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/accounts/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { accounts: [{ accountId: 42, name: "Acme" }] },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/accounts/detail",
        requestPostData: JSON.stringify({ accountId: 42 }),
        responseBody: { transactions: [{ transactionId: "t1" }] },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.joinFields).toEqual(["accountId"]);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["transactions"]);
  });

  it("resolves a join field threaded only as a URL path segment, never a query param or body value", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownPathThreadedJoinActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.joinFields).toEqual(["accountId"]);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["transactions"]);
  });

  it("resolves a composite join key mixing a string field and a numeric field, in item key order", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownCompositeNumericJoinActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.joinFields).toEqual(["region", "accountId"]);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["transactions"]);
  });

  it("resolves a join field nested inside an object as a dot-separated path", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownNestedJoinFieldActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.joinFields).toEqual(["identifiers.sku"]);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["transactions"]);
  });

  it("resolves the real primary results array over a decoy positioned earlier in key order", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownActionSteps());

    // The primary response's decoy `facets[]` array is positioned before
    // `results[]` in key order, so a plain DFS-first search would pick it —
    // only `results[]`'s items thread the `sku` join value into the
    // drill-down's request, so that's what must be selected instead.
    expect(plan).not.toBeNull();
    expect(plan?.primaryArrayPath).toEqual(["results"]);
    expect(plan?.primaryArrayPath).not.toEqual(["facets"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["sku"]);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["prices"]);
  });

  it("resolves the real drill-down array over a decoy positioned earlier in key order", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownDrillDecoyActionSteps());

    // The drill-down response's decoy `errors[]` array is positioned before
    // `details[]` in key order, so a plain DFS-first search would pick it —
    // only `details[]`'s items thread the `sku` join value into that same
    // drill-down request, so that's what must be selected instead.
    expect(plan).not.toBeNull();
    expect(plan?.primaryArrayPath).toEqual(["results"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["sku"]);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["details"]);
    expect(plan?.targets[0]?.drillArrayPath).not.toEqual(["errors"]);
  });

  it("returns null when no candidate array on either side threads a join value into the drill request", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/catalog/search/",
        requestPostData: '{"page":1}',
        responseBody: {
          facets: [{ name: "brand" }],
          results: [{ sku: "sku-a" }, { sku: "sku-b" }],
        },
        timestamp: "2024-04-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/catalog/pricing/",
        // Neither candidate item's field value (nor either drill-side
        // candidate's own item fields) appears anywhere in this request, so
        // there is nothing to disambiguate a real array from a decoy by.
        requestPostData: '{"lookup":true}',
        responseBody: {
          errors: [{ code: "none" }],
          details: [{ sku: "sku-a", price: 19.99 }],
        },
        timestamp: "2024-04-01T00:00:01Z",
      }),
    ];

    expect(detect(steps)).toBeNull();
  });

  it("returns null when the join value is threaded only via a request header, never the URL or JSON body", () => {
    const steps = buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps();

    // collectRequestStringValues deliberately never scans requestHeaders, so
    // the structural heuristic has nothing to disambiguate the drill-down
    // request by even though the join value is right there in the header.
    expect(detect(steps)).toBeNull();
    expect(resolveFoldPlan(steps)).toEqual([]);
  });
});

describe("detectDrillDownFoldPlan — nested grouping array", () => {
  it("detects a primary results array nested inside an outer grouping array", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/catalog/sections",
        requestPostData: null,
        responseBody: {
          sections: [
            {
              label: "featured",
              entries: [
                { entryId: "e1", name: "Widget" },
                { entryId: "e2", name: "Gadget" },
              ],
            },
          ],
        },
        timestamp: "2024-05-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/catalog/entries/e2/details",
        requestPostData: null,
        responseBody: {
          details: [{ entryId: "e2", description: "A gadget." }],
        },
        timestamp: "2024-05-01T00:00:01Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    // The literal group index is never baked in — "*" marks the outer
    // sections[] array as a whole, so the accessor generalizes to N groups
    // (see ARRAY_WILDCARD_SEGMENT in recon-generate.ts) instead of freezing
    // whichever group happened to contain the matched item.
    expect(plan?.primaryArrayPath).toEqual(["sections", "*", "entries"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["entryId"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["details"]);
    expect(plan?.targets[0]?.primaryMatchedItemIndex).toBe(1);
  });

  it("resolves primaryMatchedItemIndex as the GLOBAL flattened index across every outer group, not the local index within the one group that matched", () => {
    const steps = buildMulticallNestedGroupedDrillDownMultiGroupActionSteps();

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.primaryArrayPath).toEqual(["sections", "*", "entries"]);
    // sections[0].entries = [e1, e3]; sections[1].entries = [e2, e4]; the
    // drilled entry (e2) is local index 0 of group 1, but flattened across
    // both groups in outer-array order ([e1, e3, e2, e4]) it is index 2 —
    // freezing the local index (0) or assuming group 0 (as a single-group
    // fixture can never disprove) would land the fold on the wrong item.
    expect(plan?.targets[0]?.primaryMatchedItemIndex).toBe(2);
    expect(plan?.targets[0]?.joinFields).toEqual(["entryId"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["details"]);
  });
});

describe("detectDrillDownFoldPlan — chained per-item dependency", () => {
  it("chains a further step whose request threads a value the drill call's response produced, ending at the step holding the foldable array", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/orders/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { results: [{ orderId: "order-7" }] },
        timestamp: "2024-06-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/orders/order-7/status",
        requestPostData: null,
        // `tags` satisfies detectDrillDownFoldPlan's own drill-array
        // requirement, but it is a DECOY — the real per-item results only
        // show up on the step this one's `statusToken` threads into.
        responseBody: { statusToken: "tok-99", tags: [{ tag: "expedited" }] },
        timestamp: "2024-06-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/orders/history",
        requestPostData: JSON.stringify({ token: "tok-99" }),
        responseBody: { entries: [{ ts: "2024-06-01T00:00:02Z", event: "shipped" }] },
        timestamp: "2024-06-01T00:00:02Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["entries"]);
  });

  it("extends the chain past an immediate drill hop whose response has no object-array/flat-object candidate at all", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/orders/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { results: [{ orderId: "order-7" }] },
        timestamp: "2024-06-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/orders/order-7/status",
        requestPostData: null,
        // A bare array of primitive strings — no object-array field and no
        // flat-object shape, so `selectDisambiguatedCandidate` returns null
        // for this hop. The real per-item data only shows up on the step
        // this response's lone token threads into.
        responseBody: ["tok-99"],
        timestamp: "2024-06-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/orders/history",
        requestPostData: JSON.stringify({ token: "tok-99" }),
        responseBody: { entries: [{ ts: "2024-06-01T00:00:02Z", event: "shipped" }] },
        timestamp: "2024-06-01T00:00:02Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["entries"]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(2);
  });

  it("disambiguates a decoy array positioned earlier in key order than the real array on the chain's SECOND step, not the immediate drill step", () => {
    const steps = buildMulticallSingleShotSearchDrillDownChainedDecoyOnChainTerminalActionSteps();

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["entries"]);
  });

  it("degrades to a single-entry chain when nothing downstream threads a value out of the drill response", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.chain).toEqual([plan?.targets[0]?.drillStepIndex]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(plan?.targets[0]?.drillArrayPath);
  });

  it("extends the chain past a drill step that is itself foldable, when a further step also depends on it", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.targets[0]?.joinFields).toEqual(["sku"]);
    // r1 (the price lookup) is a valid drill step in isolation — its own
    // `prices[]` is foldable — but r2 (price-history) threads r1's
    // `priceToken`, so the chain must not stop at r1.
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["prices"]);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["history"]);
  });

  it("resolves the chain past a foldable-in-isolation drill step when the primary's join key is nested", () => {
    const plan = detect(
      buildMulticallSingleShotSearchDrillDownNestedJoinFieldChainedDependentActionSteps()
    );

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.joinFields).toEqual(["identifiers.sku"]);
    // The nested join value ("sku-b") only satisfies the SECOND primary
    // item, so `primaryMatchedItemIndex` must resolve by walking into each
    // item's nested fields rather than assuming the first item matches.
    expect(plan?.targets[0]?.primaryMatchedItemIndex).toBe(1);
    // r1 (the price lookup) is foldable on its own terms — its own
    // `prices[]` is a real object-array — but r2 (price-history) threads
    // r1's `priceToken`, so the chain must not stop at r1.
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["prices"]);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["history"]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(2);
  });

  it("resolves a nested-join primary item through an opaque intermediate hop to the real chain terminal", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/orders/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          results: [
            { identifiers: { orderId: "order-a" } },
            { identifiers: { orderId: "order-b" } },
          ],
        },
        timestamp: "2024-06-02T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/orders/order-b/status",
        requestPostData: JSON.stringify({ orderId: "order-b" }),
        // A bare array of primitive strings — no object-array field and no
        // flat-object shape, so this hop has no candidate of its own. The
        // real per-item data only shows up on the step this response's lone
        // token threads into.
        responseBody: ["tok-77"],
        timestamp: "2024-06-02T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/orders/history",
        requestPostData: JSON.stringify({ token: "tok-77" }),
        responseBody: { entries: [{ ts: "2024-06-02T00:00:02Z", event: "delivered" }] },
        timestamp: "2024-06-02T00:00:02Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.primaryArrayPath).toEqual(["results"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["identifiers.orderId"]);
    // The join value ("order-b") only satisfies the SECOND primary item, so
    // `primaryMatchedItemIndex` must resolve by walking into each item's
    // nested fields rather than assuming the first item matches.
    expect(plan?.targets[0]?.primaryMatchedItemIndex).toBe(1);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    // The chain must extend past the opaque r1 hop to r2, the step that
    // actually holds the foldable array.
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["entries"]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(2);
  });

  it("resolves the chain terminal to a flat-object response two hops past the immediate drill step", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/orders/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { orders: [{ orderId: "order-9" }] },
        timestamp: "2024-10-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/orders/order-9/status",
        requestPostData: null,
        // Flat, single-field body — the immediate drill step's own richness
        // baseline that a later chain member must exceed to displace it.
        responseBody: { token: "tok-1" },
        timestamp: "2024-10-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/orders/history",
        requestPostData: JSON.stringify({ token: "tok-1" }),
        // Side-effect-only: its only field beyond the echoed threaded token
        // is a bare flag, no richer than r1's own single field.
        responseBody: { confirmed: true, token: "tok-1" },
        timestamp: "2024-10-01T00:00:02Z",
      }),
      buildStep("r3", {
        url: "https://api.example.com/orders/order-9/receipt",
        requestPostData: JSON.stringify({ token: "tok-1" }),
        // Genuinely richer flat object — the real terminal, two hops past
        // the drill step (r1 -> r2 -> r3).
        responseBody: { receiptId: "rcpt-1", amount: 42, token: "tok-1" },
        timestamp: "2024-10-01T00:00:03Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1, 2, 3]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual([]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(3);
  });

  it("skips a side-effect-only intermediate response, keeping the drill step's own array as the terminal", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/accounts/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { accounts: [{ accountId: "acc-1" }] },
        timestamp: "2024-10-02T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/accounts/acc-1/transactions",
        requestPostData: null,
        responseBody: { transactions: [{ transactionId: "t1", amount: 10 }] },
        timestamp: "2024-10-02T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/accounts/acc-1/ack",
        requestPostData: JSON.stringify({ transactionId: "t1" }),
        // No object-array field of its own, and its only non-echoed field
        // (`acknowledged`) carries strictly less per-item data than r1's
        // matched transaction item — must not become the terminal.
        responseBody: { transactionId: "t1", acknowledged: true },
        timestamp: "2024-10-02T00:00:02Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["transactions"]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(1);
  });

  it("keeps a richer earlier array-bearing chain step as the terminal over a later, poorer array-bearing step", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/catalog/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { results: [{ itemId: "item-5" }] },
        timestamp: "2024-11-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/catalog/items/item-5/detail",
        requestPostData: null,
        // Rich object-array per item — the genuine terminal that must win.
        responseBody: {
          rows: [{ sku: "sku-1", price: 20, quantity: 3, warehouse: "w1" }],
          token: "tok-42",
        },
        timestamp: "2024-11-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/catalog/items/item-5/audit",
        requestPostData: JSON.stringify({ token: "tok-42" }),
        // Also an object-array, but with strictly fewer primitive fields
        // per item than r1's — must NOT displace r1 as the terminal.
        responseBody: { entries: [{ action: "viewed" }], token: "tok-42" },
        timestamp: "2024-11-01T00:00:02Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["rows"]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(1);
  });

  it("advances the terminal to a later flat-object step whose own data outweighs the drill step's echo-inflated baseline", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/widgets/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { results: [{ widgetId: "widget-7" }] },
        timestamp: "2024-12-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/widgets/widget-7/status",
        requestPostData: null,
        // The drill step's own response echoes the threaded widgetId
        // (present in its own request URL) alongside one lightweight,
        // non-echoed field. Uncorrected, this echoed field inflates the
        // baseline richness a later step must exceed.
        responseBody: { widgetId: "widget-7", status: "active" },
        timestamp: "2024-12-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/widgets/widget-7/detail",
        requestPostData: JSON.stringify({ status: "active" }),
        // Threads r1's `status` value onward, and itself echoes it, but
        // carries strictly more of its own non-echoed data than r1's real
        // (echo-excluded) richness of 1 — this is the genuine terminal.
        responseBody: { status: "active", detailId: "detail-1", quantity: 9 },
        timestamp: "2024-12-01T00:00:02Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual([]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(2);
  });

  it("advances past a confirmation hop whose non-echoed richness merely TIES the real terminal's, instead of freezing on the tie", () => {
    const steps =
      buildMulticallSingleShotSearchDrillDownRichnessTiedConfirmationHopChainedDependentActionSteps();

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    // r2 (the flat confirmation hop) and r3 (the real per-item terminal)
    // both carry two non-echoed primitive fields apiece, so a strict `>`
    // richness comparison never lets r3 displace r2 — the chain must still
    // extend all the way to r3, not stop at the tied confirmation hop.
    expect(plan?.targets[0]?.chain).toEqual([1, 2, 3]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["entries"]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(3);
  });

  it("extends the chain past an opaque intermediate hop to the step holding the real per-item array", () => {
    const plan = detect(
      buildMulticallSingleShotSearchDrillDownOpaqueIntermediateChainedDependentActionSteps()
    );

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["entries"]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(2);
  });

  it("resolves the chain to the terminal step even when it threads the drill step's value wrapped inside a request-body array", () => {
    const plan = detect(
      buildMulticallSingleShotSearchDrillDownArrayWrappedChainedDependentActionSteps()
    );

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["entries"]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(2);
  });

  it("resolves the immediate drill step's join field even when the primary item's numeric join value is wrapped inside a request-body array", () => {
    const plan = detect(
      buildMulticallSingleShotSearchDrillDownArrayWrappedNumericImmediateJoinFieldActionSteps()
    );

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(0);
    expect(plan?.targets[0]?.joinFields).toEqual(["orderId"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(plan?.targets[0]?.chainArrayPath).toEqual(["entries"]);
    expect(plan?.targets[0]?.chainTerminalIndex).toBe(2);
  });
});

describe("detectDrillDownFoldPlan — multiple independent targets", () => {
  it("detects two independently-threaded per-item drill-downs off the same primary array", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/catalog/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          items: [
            { itemId: "i1", sku: "sku-1" },
            { itemId: "i2", sku: "sku-2" },
          ],
        },
        timestamp: "2024-07-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/catalog/items/i1/reviews",
        requestPostData: null,
        responseBody: { reviews: [{ itemId: "i1", rating: 5 }] },
        timestamp: "2024-07-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/catalog/items/sku-2/inventory",
        requestPostData: null,
        responseBody: { stock: [{ sku: "sku-2", qty: 3 }] },
        timestamp: "2024-07-01T00:00:02Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.primaryArrayPath).toEqual(["items"]);
    expect(plan?.targets).toHaveLength(2);
    expect(plan?.targets[0]?.joinFields).toEqual(["itemId"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["reviews"]);
    expect(plan?.targets[1]?.joinFields).toEqual(["sku"]);
    expect(plan?.targets[1]?.drillStepIndex).toBe(2);
    expect(plan?.targets[1]?.drillArrayPath).toEqual(["stock"]);
  });

  it("does not chain a second per-item drill under the first merely because both thread the same primary join value", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/catalog/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          items: [{ sku: "sku-a" }, { sku: "sku-b" }],
        },
        timestamp: "2024-09-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/catalog/items/sku-a/pricing",
        requestPostData: null,
        // Echoes the primary's own `sku` join value alongside its own
        // field — an echo, not evidence a later step depends on THIS
        // step's response, since `sku-a` was already on the primary item.
        responseBody: { pricing: [{ sku: "sku-a", amount: 42 }] },
        timestamp: "2024-09-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/catalog/items/sku-a/reviews",
        requestPostData: null,
        responseBody: { reviews: [{ sku: "sku-a", rating: 5 }] },
        timestamp: "2024-09-01T00:00:02Z",
      }),
    ];

    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.targets).toHaveLength(2);
    expect(plan?.targets[0]?.drillStepIndex).toBe(1);
    expect(plan?.targets[0]?.chain).toEqual([1]);
    expect(plan?.targets[1]?.drillStepIndex).toBe(2);
    expect(plan?.targets[1]?.chain).toEqual([2]);
  });
});

describe("detectDrillDownFoldPlan — multiple independent primaries", () => {
  it("returns a plan for EVERY independent primary/drill-down pair, not just the first", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/products/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          products: [
            { productId: "p1", name: "Widget" },
            { productId: "p2", name: "Gadget" },
          ],
        },
        timestamp: "2024-08-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/products/p1/reviews",
        requestPostData: null,
        responseBody: { reviews: [{ productId: "p1", rating: 5 }] },
        timestamp: "2024-08-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/vendors/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          vendors: [
            { vendorId: "v1", name: "Acme" },
            { vendorId: "v2", name: "Globex" },
          ],
        },
        timestamp: "2024-08-01T00:00:02Z",
      }),
      buildStep("r3", {
        url: "https://api.example.com/vendors/v1/contracts",
        requestPostData: null,
        responseBody: { contracts: [{ vendorId: "v1", contractId: "c1" }] },
        timestamp: "2024-08-01T00:00:03Z",
      }),
    ];

    const plans = detectAll(steps);

    expect(plans).toHaveLength(2);
    expect(plans[0]?.primaryStepIndex).toBe(0);
    expect(plans[0]?.primaryArrayPath).toEqual(["products"]);
    expect(plans[0]?.targets).toHaveLength(1);
    expect(plans[0]?.targets[0]?.joinFields).toEqual(["productId"]);
    expect(plans[0]?.targets[0]?.drillStepIndex).toBe(1);
    expect(plans[0]?.targets[0]?.drillArrayPath).toEqual(["reviews"]);
    expect(plans[1]?.primaryStepIndex).toBe(2);
    expect(plans[1]?.primaryArrayPath).toEqual(["vendors"]);
    expect(plans[1]?.targets).toHaveLength(1);
    expect(plans[1]?.targets[0]?.joinFields).toEqual(["vendorId"]);
    expect(plans[1]?.targets[0]?.drillStepIndex).toBe(3);
    expect(plans[1]?.targets[0]?.drillArrayPath).toEqual(["contracts"]);
  });
});

describe("detectDrillDownFoldPlan — two independent arrays on the SAME primary step", () => {
  it("returns one FoldPlan per distinct array field, not just whichever one the first drill-down threads from", () => {
    const plans = detectAll(buildMulticallSingleShotSearchTwoIndependentArraysActionSteps());

    expect(plans).toHaveLength(2);
    expect(plans[0]?.primaryStepIndex).toBe(0);
    expect(plans[0]?.primaryArrayPath).toEqual(["products"]);
    expect(plans[0]?.targets).toHaveLength(1);
    expect(plans[0]?.targets[0]?.joinFields).toEqual(["sku"]);
    expect(plans[0]?.targets[0]?.drillStepIndex).toBe(1);
    expect(plans[0]?.targets[0]?.drillArrayPath).toEqual(["prices"]);

    expect(plans[1]?.primaryStepIndex).toBe(0);
    expect(plans[1]?.primaryArrayPath).toEqual(["vendors"]);
    expect(plans[1]?.targets).toHaveLength(1);
    expect(plans[1]?.targets[0]?.joinFields).toEqual(["vendorId"]);
    expect(plans[1]?.targets[0]?.drillStepIndex).toBe(2);
    expect(plans[1]?.targets[0]?.drillArrayPath).toEqual(["contracts"]);
  });

  it("resolveFoldPlan folds both independent arrays on the same primary step", () => {
    const resolved = resolveFoldPlan(
      buildMulticallSingleShotSearchTwoIndependentArraysActionSteps()
    );

    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.primaryArrayPath).toEqual(["products"]);
    expect(resolved[1]?.primaryArrayPath).toEqual(["vendors"]);
  });
});

describe("resolveFoldPlan — spec plan for a second, independent array on an already-used primary step", () => {
  it("appends the spec's plan instead of dropping it as already-consumed, when its primaryArrayPath differs from the structural plan's on the same step", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/catalog/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          products: [{ sku: "sku-a" }],
          vendors: [{ vendorId: "v1" }],
        },
        timestamp: "2025-02-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/catalog/pricing?sku=sku-a",
        requestPostData: null,
        responseBody: { prices: [{ sku: "sku-a", amount: 9.99 }] },
        timestamp: "2025-02-01T00:00:01Z",
      }),
      // The vendor-detail call's join value threads only through a request
      // header, invisible to the structural heuristic — only a flow-declared
      // foldReturn spec naming `vendors` as its resultsPath can resolve it.
      buildStep("r2", {
        url: "https://api.example.com/catalog/vendors/detail",
        requestPostData: '{"lookup":true}',
        responseBody: { contracts: [{ vendorId: "v1", contractId: "c1" }] },
        timestamp: "2025-02-01T00:00:02Z",
        requestHeaders: { "Content-Type": "application/json", "X-Vendor-Id": "v1" },
      }),
    ];

    // The structural heuristic resolves only the `products` array (r0/r1) —
    // `vendors` is entirely invisible to it since r2's join threads only
    // through a header.
    const structuralPlans = detectDrillDownFoldPlan(steps);
    expect(structuralPlans).toHaveLength(1);
    expect(structuralPlans[0]?.primaryStepIndex).toBe(0);
    expect(structuralPlans[0]?.primaryArrayPath).toEqual(["products"]);

    const spec: FoldReturnSpec = {
      endpointPattern: "catalog/vendors/detail",
      resultsPath: "vendors",
      joinFields: ["vendorId"],
    };

    const resolved = resolveFoldPlan(steps, spec);

    // Before the fix, mergeSpecPlanOntoSamePrimary keyed its consumed-index
    // check off primaryStepIndex alone, so the spec's plan — anchored on
    // the SAME step 0, but naming a different array — was wrongly treated
    // as already consumed and dropped, leaving only the structural plan.
    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.primaryArrayPath).toEqual(["products"]);
    expect(resolved[1]?.primaryStepIndex).toBe(0);
    expect(resolved[1]?.primaryArrayPath).toEqual(["vendors"]);
    expect(resolved[1]?.targets[0]?.drillStepIndex).toBe(2);
  });
});

describe("resolveFoldPlan — multiple independent primaries", () => {
  it("returns a resolved fold plan for EVERY independent primary/drill-down pair when neither is disqualified", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/products/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          products: [
            { productId: "p1", name: "Widget" },
            { productId: "p2", name: "Gadget" },
          ],
        },
        timestamp: "2024-09-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/products/p1/reviews",
        requestPostData: null,
        responseBody: { reviews: [{ productId: "p1", rating: 5 }] },
        timestamp: "2024-09-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/vendors/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          vendors: [
            { vendorId: "v1", name: "Acme" },
            { vendorId: "v2", name: "Globex" },
          ],
        },
        timestamp: "2024-09-01T00:00:02Z",
      }),
      buildStep("r3", {
        url: "https://api.example.com/vendors/v1/contracts",
        requestPostData: null,
        responseBody: { contracts: [{ vendorId: "v1", contractId: "c1" }] },
        timestamp: "2024-09-01T00:00:03Z",
      }),
    ];

    const resolved = resolveFoldPlan(steps);

    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.primaryStepIndex).toBe(0);
    expect(resolved[0]?.targets[0]?.drillStepIndex).toBe(1);
    expect(resolved[1]?.primaryStepIndex).toBe(2);
    expect(resolved[1]?.targets[0]?.drillStepIndex).toBe(3);
  });

  it("drops the whole plan whose sole target is multipart-disqualified, keeping the other independent plan", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/products/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          products: [
            { productId: "p1", name: "Widget" },
            { productId: "p2", name: "Gadget" },
          ],
        },
        timestamp: "2024-08-01T00:00:00Z",
      }),
      {
        ...buildStep("r1", {
          url: "https://api.example.com/products/p1/reviews",
          requestPostData: null,
          responseBody: { reviews: [{ productId: "p1", rating: 5 }] },
          timestamp: "2024-08-01T00:00:01Z",
        }),
        isMultipart: true,
      },
      buildStep("r2", {
        url: "https://api.example.com/vendors/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          vendors: [
            { vendorId: "v1", name: "Acme" },
            { vendorId: "v2", name: "Globex" },
          ],
        },
        timestamp: "2024-08-01T00:00:02Z",
      }),
      buildStep("r3", {
        url: "https://api.example.com/vendors/v1/contracts",
        requestPostData: null,
        responseBody: { contracts: [{ vendorId: "v1", contractId: "c1" }] },
        timestamp: "2024-08-01T00:00:03Z",
      }),
    ];

    expect(detectDrillDownFoldPlan(steps)).toHaveLength(2);

    const resolved = resolveFoldPlan(steps);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.primaryStepIndex).toBe(2);
    expect(resolved[0]?.primaryArrayPath).toEqual(["vendors"]);
    expect(resolved[0]?.targets[0]?.drillStepIndex).toBe(3);
  });
});

describe("resolveFoldPlan — multipart chain-step disqualification", () => {
  it("disqualifies the plan when a downstream CHAIN step (not the drill step itself) is multipart", () => {
    const steps =
      buildMulticallSingleShotSearchDrillDownChainedDependentMultipartChainStepActionSteps();

    // The structural detector still finds a plan — drillStepIndex (r1) is
    // not multipart, only the further chained step (r2) is — but
    // resolveFoldPlan must disqualify it because emitMultiStepExecuteHttp's
    // fold loop re-issues every step in `chain`, not just drillStepIndex.
    const plan = detectDrillDownFoldPlan(steps)[0] ?? null;
    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(steps[plan!.targets[0]!.drillStepIndex]!.isMultipart).toBe(false);
    expect(steps[2]!.isMultipart).toBe(true);

    expect(resolveFoldPlan(steps)).toEqual([]);
  });

  it("still resolves the plan when every chain step is a plain JSON request", () => {
    const steps = buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps();

    expect(resolveFoldPlan(steps)).toHaveLength(1);
  });

  it("drops only the multipart-disqualified target, keeping the other clean target on the same primary", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/accounts/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          accounts: [
            { accountId: "41", name: "Globex" },
            { accountId: "42", name: "Acme" },
          ],
        },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/accounts/detail?accountId=41",
        requestPostData: null,
        responseBody: { transactions: [{ accountId: "41", transactionId: "t-clean" }] },
        timestamp: "2024-01-01T00:00:01Z",
      }),
      {
        ...buildStep("r2", {
          url: "https://api.example.com/accounts/detail?accountId=42",
          requestPostData: null,
          responseBody: { transactions: [{ accountId: "42", transactionId: "t-multipart" }] },
          timestamp: "2024-01-01T00:00:02Z",
        }),
        isMultipart: true,
      },
    ];

    const structuralPlan = detectDrillDownFoldPlan(steps)[0] ?? null;
    expect(structuralPlan?.targets).toHaveLength(2);

    const resolved = resolveFoldPlan(steps);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.targets).toHaveLength(1);
    expect(resolved[0]?.targets[0]?.drillStepIndex).toBe(1);
  });

  it("drops only the multipart-disqualified target when the surviving target is a different, independently-threaded drill-down", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/catalog/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          items: [
            { itemId: "i1", sku: "sku-1" },
            { itemId: "i2", sku: "sku-2" },
          ],
        },
        timestamp: "2024-07-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/catalog/items/i1/reviews",
        requestPostData: null,
        responseBody: { reviews: [{ itemId: "i1", rating: 5 }] },
        timestamp: "2024-07-01T00:00:01Z",
      }),
      {
        ...buildStep("r2", {
          url: "https://api.example.com/catalog/items/sku-2/inventory",
          requestPostData: null,
          responseBody: { stock: [{ sku: "sku-2", qty: 3 }] },
          timestamp: "2024-07-01T00:00:02Z",
        }),
        isMultipart: true,
      },
    ];

    const structuralPlan = detectDrillDownFoldPlan(steps)[0] ?? null;
    expect(structuralPlan?.targets).toHaveLength(2);

    const resolved = resolveFoldPlan(steps);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.targets).toHaveLength(1);
    expect(resolved[0]?.targets[0]?.drillStepIndex).toBe(1);
    expect(resolved[0]?.targets[0]?.drillArrayPath).toEqual(["reviews"]);
  });

  it("returns an empty array when every target for the primary is multipart-disqualified", () => {
    const steps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/accounts/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: {
          accounts: [
            { accountId: "41", name: "Globex" },
            { accountId: "42", name: "Acme" },
          ],
        },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      {
        ...buildStep("r1", {
          url: "https://api.example.com/accounts/detail?accountId=41",
          requestPostData: null,
          responseBody: { transactions: [{ accountId: "41", transactionId: "t-multipart-1" }] },
          timestamp: "2024-01-01T00:00:01Z",
        }),
        isMultipart: true,
      },
      {
        ...buildStep("r2", {
          url: "https://api.example.com/accounts/detail?accountId=42",
          requestPostData: null,
          responseBody: { transactions: [{ accountId: "42", transactionId: "t-multipart-2" }] },
          timestamp: "2024-01-01T00:00:02Z",
        }),
        isMultipart: true,
      },
    ];

    expect(detectDrillDownFoldPlan(steps)[0]?.targets).toHaveLength(2);
    expect(resolveFoldPlan(steps)).toEqual([]);
  });
});

describe("resolveFoldPlan — header-threaded join boundary", () => {
  it("resolves the plan from a declared foldReturn spec when the join is header-threaded", () => {
    const steps = buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps();

    expect(
      resolveFoldPlan(steps, {
        endpointPattern: "/accounts/detail",
        resultsPath: "accounts",
        joinFields: ["accountId"],
      })
    ).toEqual([
      {
        primaryStepIndex: 0,
        primaryArrayPath: ["accounts"],
        targets: [
          {
            joinFields: ["accountId"],
            drillStepIndex: 1,
            drillArrayPath: ["transactions"],
            primaryMatchedItemIndex: 0,
            chain: [1],
            chainArrayPath: ["transactions"],
            chainTerminalIndex: 1,
          },
        ],
      },
    ]);
  });
});
