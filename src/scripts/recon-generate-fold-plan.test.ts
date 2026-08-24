import { describe, expect, it } from "vitest";
import { detectDrillDownFoldPlan, resolveFoldPlan } from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildMulticallNestedGroupedDrillDownMultiGroupActionSteps,
  buildMulticallSingleShotSearchDrillDownActionSteps,
  buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps,
  buildMulticallSingleShotSearchDrillDownChainedDependentMultipartChainStepActionSteps,
  buildMulticallSingleShotSearchDrillDownCompositeNumericJoinActionSteps,
  buildMulticallSingleShotSearchDrillDownCompositeNumericJoinNonFirstItemActionSteps,
  buildMulticallSingleShotSearchDrillDownDrillDecoyActionSteps,
  buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps,
  buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps,
  buildMulticallSingleShotSearchDrillDownNonFirstItemSkuActionSteps,
  buildMulticallSingleShotSearchDrillDownNumericJoinActionSteps,
  buildMulticallSingleShotSearchDrillDownOutOfOrderItemActionSteps,
  buildMulticallSingleShotSearchDrillDownPathThreadedJoinActionSteps,
  buildStep,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/** `detectDrillDownFoldPlan` takes the unexported `ActionStep[]`; the shared
 * fixture's `MulticallFixtureStep` is structurally identical except for
 * `produces` (`unknown[]` vs. the real `Produce[]`, always empty here — the
 * detector never reads it), so a type-only cast through the detector's own
 * parameter type is safe. */
function detect(steps: MulticallFixtureStep[]): ReturnType<typeof detectDrillDownFoldPlan> {
  return detectDrillDownFoldPlan(steps as unknown as Parameters<typeof detectDrillDownFoldPlan>[0]);
}

describe("detectDrillDownFoldPlan", () => {
  it("detects the available-products (requeried) + available-units drill-down, threaded on productId", () => {
    const plan = detect(buildMulticallHeterogeneousActionStepsWithDrillDown());

    expect(plan).not.toBeNull();
    expect(plan?.primaryArrayPath).toEqual(["products"]);
    expect(plan?.targets[0]?.joinFields).toEqual(["productId"]);
    expect(plan?.targets[0]?.drillStepIndex).toBe(4);
    expect(plan?.targets[0]?.drillArrayPath).toEqual(["units"]);
    // Primary must be one of the requeried available-products/ steps (r2/r3),
    // not the drill-down step itself.
    expect(plan && [2, 3]).toContain(plan?.primaryStepIndex);
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
    expect(resolveFoldPlan(steps)).toBeNull();
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
});

describe("resolveFoldPlan — multipart chain-step disqualification", () => {
  it("disqualifies the plan when a downstream CHAIN step (not the drill step itself) is multipart", () => {
    const steps =
      buildMulticallSingleShotSearchDrillDownChainedDependentMultipartChainStepActionSteps();

    // The structural detector still finds a plan — drillStepIndex (r1) is
    // not multipart, only the further chained step (r2) is — but
    // resolveFoldPlan must disqualify it because emitMultiStepExecuteHttp's
    // fold loop re-issues every step in `chain`, not just drillStepIndex.
    const plan = detectDrillDownFoldPlan(steps);
    expect(plan).not.toBeNull();
    expect(plan?.targets[0]?.chain).toEqual([1, 2]);
    expect(steps[plan!.targets[0]!.drillStepIndex]!.isMultipart).toBe(false);
    expect(steps[2]!.isMultipart).toBe(true);

    expect(resolveFoldPlan(steps)).toBeNull();
  });

  it("still resolves the plan when every chain step is a plain JSON request", () => {
    const steps = buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps();

    expect(resolveFoldPlan(steps)).not.toBeNull();
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
    ).toEqual({
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
    });
  });
});
