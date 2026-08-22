import { describe, expect, it } from "vitest";
import { detectFoldPlan, selectPayloadAction } from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildMulticallHeterogeneousActionStepsWithFoldedDrillDown,
  buildMulticallHeterogeneousActionStepsWithFoldedDrillDownLoop,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/** `detectFoldPlan` takes the unexported `ActionStep[]`; the shared fixture's
 * `MulticallFixtureStep` is structurally identical except for `produces`
 * (`unknown[]` vs. the real `Produce[]`), so a type-only cast through the
 * function's own parameter type is safe — same pattern
 * recon-generate-fold-detection.test.ts uses. */
function detect(steps: MulticallFixtureStep[]): ReturnType<typeof detectFoldPlan> {
  return detectFoldPlan(steps as unknown as Parameters<typeof detectFoldPlan>[0]);
}

/** Matches recon-generate.ts's internal `endpointKey` (origin + pathname,
 * query stripped) since that helper isn't exported — the self-test asserts
 * the same identity the generator itself uses to distinguish calls. */
function endpointKey(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

describe("buildMulticallHeterogeneousActionSteps", () => {
  const steps = buildMulticallHeterogeneousActionSteps();

  /** Distinct response SHAPES (toggles array, `{result,successful}` auth
   * mint, `{totalPages,totalAvailableListings,products[]}` inventory) —
   * the inventory shape appears on 2 of the 4 steps since
   * selectPayloadAction's re-query signature requires >=2 steps at the same
   * endpointKey with distinct requestPostData (recon-generate.ts:313-334). */
  it("returns 4 ActionSteps covering 3 distinct response shapes", () => {
    expect(steps).toHaveLength(4);
  });

  it("has endpointKeys that differ across the 3 distinct endpoints (toggles, authz, available-products)", () => {
    const keys = new Set(steps.map((s) => endpointKey(s.capture.url)));
    expect(keys.size).toBe(3);
  });

  it("has pairwise disjoint top-level response-body key sets across the 3 distinct endpoints", () => {
    const keySetByEndpoint = new Map<string, Set<string>>();
    for (const s of steps) {
      const body = s.capture.responseBody;
      const keySet = Array.isArray(body)
        ? new Set(["<array>"])
        : new Set(Object.keys(body as Record<string, unknown>));
      keySetByEndpoint.set(endpointKey(s.capture.url), keySet);
    }

    const keySets = [...keySetByEndpoint.values()];
    for (let i = 0; i < keySets.length; i++) {
      for (let j = i + 1; j < keySets.length; j++) {
        const a = keySets[i];
        const b = keySets[j];
        if (!a || !b) throw new Error("unreachable");
        const intersection = [...a].filter((k) => b.has(k));
        expect(intersection).toEqual([]);
      }
    }
  });

  it("re-queries available-products/ with two distinct request bodies, so selectPayloadAction picks it", () => {
    const productsSteps = steps.filter((s) => s.capture.url.includes("available-products/"));
    expect(productsSteps).toHaveLength(2);
    expect(new Set(productsSteps.map((s) => s.capture.requestPostData)).size).toBe(2);

    const selected = selectPayloadAction(steps);
    expect(selected?.capture.url).toContain("available-products/");
  });

  it("selectPayloadAction does not pick the toggles or authz calls that merely opened the flow", () => {
    const selected = selectPayloadAction(steps);
    expect(selected?.capture.url).not.toContain("toggles/product-avail");
    expect(selected?.capture.url).not.toContain("authz/private");
  });
});

describe("buildMulticallHeterogeneousActionStepsWithDrillDown", () => {
  const steps = buildMulticallHeterogeneousActionStepsWithDrillDown();

  it("returns 5 steps with the drill-down available-units/ call last", () => {
    expect(steps).toHaveLength(5);
    expect(steps[steps.length - 1]?.capture.url).toContain("available-units/");
  });

  it("still selects available-products/ as the payload action, not the terminal drill-down", () => {
    const selected = selectPayloadAction(steps);
    expect(selected?.capture.url).toContain("available-products/");
    expect(selected?.capture.url).not.toContain("available-units/");
  });
});

describe("buildMulticallHeterogeneousActionStepsWithFoldedDrillDown", () => {
  const steps = buildMulticallHeterogeneousActionStepsWithFoldedDrillDown();

  it("returns 5 steps with the drill-down available-units/ call last", () => {
    expect(steps).toHaveLength(5);
    expect(steps[steps.length - 1]?.capture.url).toContain("available-units/");
  });

  it("annotates the primary available-products/ step with a produces entry pointing at productId inside its products[] array", () => {
    const primary = steps.find((s) => s.varName === "r2");
    expect(primary?.produces).toEqual([
      { kind: "body", name: "productId", path: ["products", "0", "productId"] },
    ]);
  });

  it("detectFoldPlan finds the fold onto r2's products[] array, keyed on productId, folding r4", () => {
    const plan = detect(steps);
    if (plan === null) throw new Error("expected a fold plan");
    expect((plan.primaryAction as MulticallFixtureStep).varName).toBe("r2");
    expect(plan.arrayContainerPath).toEqual(["products"]);
    expect(plan.joinFields).toEqual(["productId"]);
    expect((plan.drillAction as MulticallFixtureStep).varName).toBe("r4");
  });
});

describe("buildMulticallHeterogeneousActionStepsWithFoldedDrillDownLoop", () => {
  const steps = buildMulticallHeterogeneousActionStepsWithFoldedDrillDownLoop();

  it("returns 6 steps: the base 4, plus one available-units/ drill-down per product", () => {
    expect(steps).toHaveLength(6);
    const drillSteps = steps.filter((s) => s.capture.url.includes("available-units/"));
    expect(drillSteps).toHaveLength(2);
    expect(drillSteps.map((s) => s.capture.requestPostData)).toEqual([
      '{"productId":"p1"}',
      '{"productId":"p2"}',
    ]);
  });

  it("r2's products[] array carries both products the loop's drill-downs key off of", () => {
    const primary = steps.find((s) => s.varName === "r2");
    const body = primary?.capture.responseBody as { products: Array<{ productId: string }> };
    expect(body.products.map((p) => p.productId)).toEqual(["p1", "p2"]);
    expect(primary?.produces).toEqual([
      { kind: "body", name: "productId", path: ["products", "0", "productId"] },
    ]);
  });

  it("detectFoldPlan anchors the fold on r2/products/productId with r4 as the first matching drill-down", () => {
    const plan = detect(steps);
    if (plan === null) throw new Error("expected a fold plan");
    expect((plan.primaryAction as MulticallFixtureStep).varName).toBe("r2");
    expect(plan.arrayContainerPath).toEqual(["products"]);
    expect(plan.joinFields).toEqual(["productId"]);
    expect((plan.drillAction as MulticallFixtureStep).varName).toBe("r4");
  });
});
