import { describe, expect, it } from "vitest";
import { detectDrillDownFoldPlan, selectPayloadAction } from "@/scripts/recon-generate";
import {
  buildMulticallDependentDrillDownActionSteps,
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
  buildMulticallSingleShotSearchDrillDownCompositeNumericJoinNonFirstItemActionSteps,
  buildMulticallSingleShotSearchDrillDownNonFirstItemActionSteps,
  type MulticallFixtureStep,
} from "@/scripts/recon-generate-multicall-fixture";

/** `detectDrillDownFoldPlan` takes the unexported `ActionStep[]`; the shared
 * fixture's `MulticallFixtureStep` is structurally identical except for
 * `produces` (`unknown[]` vs. the real `Produce[]`, always empty here — the
 * detector never reads it), so a type-only cast through the detector's own
 * parameter type is safe (mirrors recon-generate-fold-plan.test.ts). */
function detect(steps: MulticallFixtureStep[]): ReturnType<typeof detectDrillDownFoldPlan> {
  return detectDrillDownFoldPlan(steps as unknown as Parameters<typeof detectDrillDownFoldPlan>[0]);
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

describe("buildMulticallDependentDrillDownActionSteps", () => {
  const steps = buildMulticallDependentDrillDownActionSteps();

  it("returns 4 steps: 2 search pages then 2 per-item drill-downs", () => {
    expect(steps).toHaveLength(4);
    expect(steps.filter((s) => s.capture.url.includes("catalog/search/"))).toHaveLength(2);
    expect(steps.filter((s) => s.capture.url.includes("catalog/item-detail/"))).toHaveLength(2);
  });

  it("the primary (re-queried) search page carries >=2 items, each with a join-key field", () => {
    const primaryPage = steps[1];
    const body = primaryPage?.capture.responseBody as { items: { itemId: string }[] };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    for (const item of body.items) {
      expect(typeof item.itemId).toBe("string");
    }
  });

  it("each primary item has its own corresponding drill-down capture, threaded by itemId", () => {
    const primaryPage = steps[1];
    const body = primaryPage?.capture.responseBody as { items: { itemId: string }[] };
    const drillSteps = steps.filter((s) => s.capture.url.includes("catalog/item-detail/"));

    for (const item of body.items) {
      const matching = drillSteps.filter((s) => s.capture.requestPostData?.includes(item.itemId));
      expect(matching).toHaveLength(1);
    }
  });

  it("detects a fold plan whose drill step is chosen by join key, not by call order", () => {
    const plan = detect(steps);

    expect(plan).not.toBeNull();
    expect(plan?.primaryStepIndex).toBe(1);
    expect(plan?.primaryArrayPath).toEqual(["items"]);
    expect(plan?.joinFields).toEqual(["itemId"]);
    expect(plan?.drillArrayPath).toEqual(["details"]);
    // Every primary item (not just items[0]) is searched for a threaded join
    // match, so the plan resolves to the EARLIEST later step that threads
    // ANY item's join value — r2 (index 2), threading "i-a" — rather than
    // waiting for a later step that happens to thread items[0]'s "i-b".
    expect(plan?.drillStepIndex).toBe(2);
    expect(plan?.primaryMatchedItemIndex).toBe(1);
  });
});

describe("buildMulticallSingleShotSearchDrillDownNonFirstItemActionSteps", () => {
  const steps = buildMulticallSingleShotSearchDrillDownNonFirstItemActionSteps();

  it("the primary results array carries >=2 items", () => {
    const body = steps[0]?.capture.responseBody as { results: { sku: string }[] };
    expect(body.results.length).toBeGreaterThanOrEqual(2);
  });

  it("the sole captured drill-down request carries the SECOND item's sku, never the first's", () => {
    const body = steps[0]?.capture.responseBody as { results: { sku: string }[] };
    const [firstItem, secondItem] = body.results;
    expect(firstItem).toBeDefined();
    expect(secondItem).toBeDefined();

    const drillSteps = steps.filter((s) => s.capture.url.includes("pricing"));
    expect(drillSteps).toHaveLength(1);

    const drillRequest = drillSteps[0]?.capture.requestPostData ?? "";
    expect(drillRequest).toContain(secondItem?.sku as string);
    expect(drillRequest).not.toContain(firstItem?.sku as string);
  });
});

describe("buildMulticallSingleShotSearchDrillDownCompositeNumericJoinNonFirstItemActionSteps", () => {
  const steps =
    buildMulticallSingleShotSearchDrillDownCompositeNumericJoinNonFirstItemActionSteps();

  it("the primary accounts array carries >=2 items", () => {
    const body = steps[0]?.capture.responseBody as {
      accounts: { region: string; accountId: number }[];
    };
    expect(body.accounts.length).toBeGreaterThanOrEqual(2);
  });

  it("the sole captured drill-down request carries the SECOND item's composite join key, never the first's", () => {
    const body = steps[0]?.capture.responseBody as {
      accounts: { region: string; accountId: number }[];
    };
    const [firstItem, secondItem] = body.accounts;
    expect(firstItem).toBeDefined();
    expect(secondItem).toBeDefined();

    const drillSteps = steps.filter((s) => s.capture.url.includes("accounts/detail"));
    expect(drillSteps).toHaveLength(1);

    const drillUrl = drillSteps[0]?.capture.url ?? "";
    expect(drillUrl).toContain(`region=${secondItem?.region}`);
    expect(drillUrl).toContain(`accountId=${secondItem?.accountId}`);
    expect(drillUrl).not.toContain(`region=${firstItem?.region}`);
  });
});
