import { describe, expect, it } from "vitest";
import {
  emitContractTs,
  emitMultiStepExecuteHttp,
  selectEffectiveResponseBody,
  selectReturnAction,
} from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildMulticallSingleShotSearchDrillDownNumericJoinActionSteps,
  buildMulticallSingleShotSearchDrillDownRequeriedPrimaryOverlapActionSteps,
  buildStep,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/** `emitMultiStepExecuteHttp` takes the unexported `ActionStep[]`; the shared
 * fixture's `MulticallFixtureStep` is structurally identical except for
 * `produces` (`unknown[]` vs. the real `Produce[]`, always empty here), so a
 * type-only cast through the emitter's own parameter type is safe. */
function emit(steps: MulticallFixtureStep[]): string {
  return emitMultiStepExecuteHttp(
    steps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
    null,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    "https://api.example.com",
    new Map(),
    new Map()
  );
}

/**
 * Pins G1's second surface: recon-generate.ts's response-shape-inference
 * target (formerly `actionSteps[actionSteps.length - 1]`) must agree with
 * whatever `executeHttp` actually returns at runtime — `selectReturnAction`
 * (recon-generate.ts:2255) for a plain submission flow, or the fold-merged
 * primary body for a detected drill-down fold plan, which bypasses
 * `selectReturnAction` entirely. A fix applied only at the return site would
 * leave the emitted schema/type describing a different call (or a different
 * shape of the same call) than the one `executeHttp` actually returns.
 * `selectEffectiveResponseBody` is the extracted call-site helper that
 * mirrors that same fold-plan-first, `selectReturnAction`-fallback decision,
 * guaranteeing the two selections structurally cannot drift apart.
 *
 * The emitted response SCHEMA is inferred from the same selected body on the
 * real multi-step path too (`multiStepBody` set): the client-level schema
 * describes the same call `executeHttp` returns (`selectReturnAction`), so
 * shape inference is not gated behind `multiStepBody` truthiness. Both the
 * `multiStepBody`-unset and `multiStepBody`-set assertions below therefore
 * observe the same inferred shape.
 */
describe("recon-generate — G1 shape-inference target agrees with the return target", () => {
  const steps: MulticallFixtureStep[] = buildMulticallHeterogeneousActionStepsWithDrillDown();
  // This fixture's terminal drill-down (r4) threads r2's (page 1) sole item's
  // productId — detectDrillDownFoldPlan finds a fold plan over [r2, r4], which
  // bypasses selectReturnAction entirely (see emitMultiStepExecuteHttp's own
  // "A detected drill-down fold plan bypasses selectReturnAction" comment).
  // The freshest re-queried call without a fold plan would be r3 (page 2);
  // with one, the emitted executeHttp instead loop-and-merges the drill onto
  // r2, so shape inference has to follow the fold, not the plain re-query.
  const primaryStep = steps[2]!; // r2: available-products/, page 1 (fold primary)
  const drillDownStep = steps[4]!; // r4: available-units/ terminal drill-down

  it("selects the fold-merged primary call's body, not the plain re-queried page or the raw drill-down", () => {
    const effectiveResponseBody = selectEffectiveResponseBody(true, steps, null);
    expect(effectiveResponseBody).not.toBe(primaryStep.capture.responseBody);
    expect(effectiveResponseBody).not.toBe(drillDownStep.capture.responseBody);
    expect(effectiveResponseBody).toEqual({
      totalPages: 5,
      totalAvailableListings: 699,
      products: [{ productId: "p1", unitId: "s1" }],
    });
  });

  it("agrees with the var a fold plan makes emitMultiStepExecuteHttp actually return: the folded primary, not selectReturnAction's pick", () => {
    const returnSelected = selectReturnAction(steps);
    const shapeInferenceBody = selectEffectiveResponseBody(true, steps, null);
    expect(returnSelected?.varName).toBe("r3");
    expect(shapeInferenceBody).not.toBe(returnSelected!.capture.responseBody);
  });

  it("falls back to the replay body for a non-submission (single-endpoint) flow", () => {
    const replayBody = { single: true };
    expect(selectEffectiveResponseBody(false, steps, replayBody)).toBe(replayBody);
  });

  it("shape inference fed the selected body emits inventory keys, not drill-down keys", () => {
    const effectiveResponseBody = selectEffectiveResponseBody(true, steps, null);
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: effectiveResponseBody,
      gql: false,
      gqlQuery: null,
      endpointPath: "/api/available-products",
      auxFiles: [],
      // multiStepBody intentionally unset: exercises inferZodSchema directly
      // on the selected body, decoupled from the multi-step z.unknown() gate
      // (see module doc comment above).
    });

    expect(source).toContain("totalAvailableListings");
    expect(source).toContain("products");
    expect(source).not.toContain("units");
    expect(source).not.toContain("exchangeRate");
  });

  it("the real multi-step path also infers the schema from the selected body", () => {
    const effectiveResponseBody = selectEffectiveResponseBody(true, steps, null);
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: effectiveResponseBody,
      gql: false,
      gqlQuery: null,
      endpointPath: "/api/available-products",
      auxFiles: [],
      // multiStepBody set, exactly as the real submission-flow path always
      // sets it — the selected body's shape reaches the emitted schema/type.
      multiStepBody: `    return { data: r3 };`,
    });

    expect(source).not.toContain("const TestSiteResponseSchema = z.unknown();");
    expect(source).toContain("totalAvailableListings");
  });

  it("folds a numeric-joined drill-down's sample onto the primary item, mirroring emitMultiStepExecuteHttp's own merge", () => {
    // Mirrors "folds a single-shot search's drill-down onto its results with
    // no foldReturn declaration" (recon-generate-multistep-return.test.ts:51-68),
    // but with a NUMBER join field (accountId) resolved via a URL query
    // param instead of a string one, so this exercises the fold end-to-end
    // through selectEffectiveResponseBody rather than re-testing detection.
    const numericJoinSteps = buildMulticallSingleShotSearchDrillDownNumericJoinActionSteps();

    const effectiveResponseBody = selectEffectiveResponseBody(true, numericJoinSteps, null);

    expect(effectiveResponseBody).toEqual({
      accounts: [{ accountId: 42, name: "Acme", transactionId: "t1" }],
    });
  });

  it("folds the CHAIN's terminal step's response onto the primary item, not the immediate drill step's", () => {
    // Mirrors the chained-dependency fixture in
    // recon-generate-fold-plan.test.ts ("chains a further step whose
    // request threads a value the drill call's response produced"): r1 is
    // an intermediate drill step whose own response is a decoy (`tags`
    // looks foldable but isn't the real per-item array), and r2 is the
    // chain's terminal step whose `entries` array is what the emitted loop
    // actually returns per item. Shape inference must fold r2's body, not
    // r1's, or the schema would describe a different call than executeHttp.
    const chainedSteps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/orders/search",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { results: [{ orderId: "order-7" }] },
        timestamp: "2024-06-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/orders/order-7/status",
        requestPostData: null,
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

    const effectiveResponseBody = selectEffectiveResponseBody(true, chainedSteps, null);

    expect(effectiveResponseBody).toEqual({
      results: [
        {
          orderId: "order-7",
          ts: "2024-06-01T00:00:02Z",
          event: "shipped",
        },
      ],
    });
    expect(effectiveResponseBody).not.toEqual(
      expect.objectContaining({
        results: [expect.objectContaining({ statusToken: expect.anything() })],
      })
    );
  });

  it("folds EVERY independent target's fields onto the matched primary item, not just the first target's", () => {
    // r0's sole item threads two unrelated join keys into two independent
    // drill-downs (r1 keyed on orderId, r2 keyed on customerId) — both must
    // land on the same matched item, mirroring emitMultiStepExecuteHttp's
    // own chained loop-and-merge across every FoldPlan target.
    const multiTargetSteps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/orders/list",
        requestPostData: JSON.stringify({ page: 1 }),
        responseBody: { orders: [{ orderId: "o1", customerId: "c1" }] },
        timestamp: "2024-06-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/orders/o1/tracking",
        requestPostData: null,
        responseBody: { tracking: [{ orderId: "o1", trackingCode: "TRK1" }] },
        timestamp: "2024-06-01T00:00:01Z",
      }),
      buildStep("r2", {
        url: "https://api.example.com/customers/c1/profile",
        requestPostData: null,
        responseBody: { profiles: [{ customerId: "c1", customerName: "Acme" }] },
        timestamp: "2024-06-01T00:00:02Z",
      }),
    ];

    const effectiveResponseBody = selectEffectiveResponseBody(true, multiTargetSteps, null);

    expect(effectiveResponseBody).toEqual({
      orders: [
        {
          orderId: "o1",
          customerId: "c1",
          trackingCode: "TRK1",
          customerName: "Acme",
        },
      ],
    });
  });
  it("folds the drill-down onto the freshest re-queried primary occurrence, not the first matching one", () => {
    // r0 (page 1, price: 10) and r1 (page 2, price: 12) both satisfy r2's
    // drill-down join on `sku`; the fold must anchor on r1, the freshest
    // occurrence, or shape inference would silently pin the stale price.
    const requeriedSteps =
      buildMulticallSingleShotSearchDrillDownRequeriedPrimaryOverlapActionSteps();

    const effectiveResponseBody = selectEffectiveResponseBody(true, requeriedSteps, null);

    expect(effectiveResponseBody).toEqual({
      results: [{ sku: "sku-a", price: 12, amount: 19.99 }],
    });
  });
});

describe("recon-generate — G1 shape-inference target agrees with the return target across multiple independent fold plans", () => {
  // Two unrelated primary/drill-down pairs in one action sequence —
  // resolveFoldPlan resolves both (see "detectDrillDownFoldPlan — multiple
  // independent primaries" in recon-generate-fold-plan.test.ts). Both plans'
  // own folded primary bodies are object-spread together into the returned
  // `data`; shape inference must merge the SAME two plans' folded bodies.
  const twoPrimarySteps: MulticallFixtureStep[] = [
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

  it("merges every plan's folded body, matching emitMultiStepExecuteHttp's return-value merge", () => {
    const emitted = emit(twoPrimarySteps);
    expect(emitted).toContain("return { data: { ...r0, ...r2 } };");

    const effectiveResponseBody = selectEffectiveResponseBody(true, twoPrimarySteps, null);

    expect(effectiveResponseBody).toEqual({
      products: [
        { productId: "p1", name: "Widget", rating: 5 },
        { productId: "p2", name: "Gadget" },
      ],
      vendors: [
        { vendorId: "v1", name: "Acme", contractId: "c1" },
        { vendorId: "v2", name: "Globex" },
      ],
    });
  });

  it("merges two fold plans over the SAME endpoint (differing only by query string) instead of one clobbering the other", () => {
    // r0/r2 both hit /products/search — endpointKey strips the query string,
    // so they share a key ("products") once folded, but each threads a
    // DIFFERENT drillStepIndex (r1 vs r3) into a different item, so
    // detectDrillDownFoldPlan legitimately resolves two separate FoldPlans
    // rather than collapsing them into one re-queried occurrence.
    const sameEndpointTwicePlansSteps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/products/search?page=1",
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
        url: "https://api.example.com/products/search?page=2",
        requestPostData: JSON.stringify({ page: 2 }),
        responseBody: {
          products: [
            { productId: "p3", name: "Sprocket" },
            { productId: "p4", name: "Cog" },
          ],
        },
        timestamp: "2024-09-01T00:00:02Z",
      }),
      buildStep("r3", {
        url: "https://api.example.com/products/p3/reviews",
        requestPostData: null,
        responseBody: { reviews: [{ productId: "p3", rating: 4 }] },
        timestamp: "2024-09-01T00:00:03Z",
      }),
    ];

    const effectiveResponseBody = selectEffectiveResponseBody(
      true,
      sameEndpointTwicePlansSteps,
      null
    );

    const productsArray = (effectiveResponseBody as { products: unknown[] }).products;
    expect(productsArray).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: "p1", rating: 5 }),
        expect.objectContaining({ productId: "p3", rating: 4 }),
      ])
    );
    expect(productsArray).toHaveLength(4);
  });
});
