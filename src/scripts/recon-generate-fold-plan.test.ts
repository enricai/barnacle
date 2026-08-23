import { describe, expect, it } from "vitest";
import { detectDrillDownFoldPlan, resolveFoldPlan } from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildMulticallSingleShotSearchDrillDownActionSteps,
  buildMulticallSingleShotSearchDrillDownCompositeNumericJoinActionSteps,
  buildMulticallSingleShotSearchDrillDownDrillDecoyActionSteps,
  buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinActionSteps,
  buildMulticallSingleShotSearchDrillDownNoDecoyActionSteps,
  buildMulticallSingleShotSearchDrillDownNumericJoinActionSteps,
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
    expect(plan?.joinFields).toEqual(["productId"]);
    expect(plan?.drillStepIndex).toBe(4);
    expect(plan?.drillArrayPath).toEqual(["units"]);
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
    expect(plan?.joinFields).toEqual(["sku"]);
    expect(plan?.drillStepIndex).toBe(1);
    expect(plan?.drillArrayPath).toEqual(["prices"]);
  });

  it("resolves a numeric-typed join field threaded via a URL query param", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownNumericJoinActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.joinFields).toEqual(["accountId"]);
    expect(plan?.drillArrayPath).toEqual(["transactions"]);
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
    expect(plan?.joinFields).toEqual(["accountId"]);
    expect(plan?.drillArrayPath).toEqual(["transactions"]);
  });

  it("resolves a join field threaded only as a URL path segment, never a query param or body value", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownPathThreadedJoinActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.joinFields).toEqual(["accountId"]);
    expect(plan?.drillArrayPath).toEqual(["transactions"]);
  });

  it("resolves a composite join key mixing a string field and a numeric field, in item key order", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownCompositeNumericJoinActionSteps());

    expect(plan).not.toBeNull();
    expect(plan?.joinFields).toEqual(["region", "accountId"]);
    expect(plan?.drillArrayPath).toEqual(["transactions"]);
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
    expect(plan?.joinFields).toEqual(["sku"]);
    expect(plan?.drillArrayPath).toEqual(["prices"]);
  });

  it("resolves the real drill-down array over a decoy positioned earlier in key order", () => {
    const plan = detect(buildMulticallSingleShotSearchDrillDownDrillDecoyActionSteps());

    // The drill-down response's decoy `errors[]` array is positioned before
    // `details[]` in key order, so a plain DFS-first search would pick it —
    // only `details[]`'s items thread the `sku` join value into that same
    // drill-down request, so that's what must be selected instead.
    expect(plan).not.toBeNull();
    expect(plan?.primaryArrayPath).toEqual(["results"]);
    expect(plan?.joinFields).toEqual(["sku"]);
    expect(plan?.drillArrayPath).toEqual(["details"]);
    expect(plan?.drillArrayPath).not.toEqual(["errors"]);
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
      joinFields: ["accountId"],
      drillStepIndex: 1,
      drillArrayPath: ["transactions"],
    });
  });
});
