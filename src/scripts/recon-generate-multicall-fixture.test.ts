import { describe, expect, it } from "vitest";
import { selectPayloadAction } from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
} from "@/scripts/recon-generate-multicall-fixture";

/** Mirrors recon-generate.ts's internal `endpointKey` (origin + pathname,
 * query stripped) since that helper isn't exported — the self-test asserts
 * the same identity the generator itself uses to distinguish calls. */
function endpointKey(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

describe("buildMulticallHeterogeneousActionSteps", () => {
  const steps = buildMulticallHeterogeneousActionSteps();

  /** Distinct response SHAPES (toggles array, `{result,successful}` auth
   * mint, `{totalPages,totalAvailableCruises,products[]}` inventory) named in
   * the report — the inventory shape appears on 2 of the 4 steps since
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

  it("returns 5 steps with the drill-down available-sailings/ call last", () => {
    expect(steps).toHaveLength(5);
    expect(steps[steps.length - 1]?.capture.url).toContain("available-sailings/");
  });

  it("still selects available-products/ as the payload action, not the terminal drill-down", () => {
    const selected = selectPayloadAction(steps);
    expect(selected?.capture.url).toContain("available-products/");
    expect(selected?.capture.url).not.toContain("available-sailings/");
  });
});
