import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveApplicableFoldPlans } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";

/**
 * Mirrors recon-generate-foldreturn-declared-joinfields-single-primary-anchor-unit.test.ts
 * but the primary results live under `warehouses.*.zones.*.bins` — TWO
 * ARRAY_WILDCARD_SEGMENT crossings, not one — and the drill URL threads the
 * structural ids (`warehouseId`/`zoneId`) while the declared `binId` join
 * field is only ever echoed on the drill RESPONSE. Proves the declared
 * joinFields still win once resolving the plan requires flattening across
 * two nested wildcard levels, not just one.
 */
function buildDoubleWildcardDrillDownSteps(): MulticallFixtureStep[] {
  const primary = buildStep("r0", {
    url: `${BASE}/inventory/search/`,
    requestPostData: JSON.stringify({ query: "forklifts" }),
    responseBody: {
      warehouses: [
        {
          warehouseId: "wh-1",
          zones: [
            {
              zoneId: "zone-1",
              bins: [{ binId: "bin-1" }],
            },
          ],
        },
      ],
    },
    timestamp: "2026-01-01T00:00:00Z",
  });

  const drill = buildStep("r1", {
    url: `${BASE}/inventory/warehouses/wh-1/zones/zone-1/availability/`,
    requestPostData: null,
    responseBody: { availability: [{ binId: "bin-1", quantity: 42 }] },
    timestamp: "2026-01-01T00:00:01Z",
    method: "GET",
  });

  return [primary, drill];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/zones/zone-1/availability/",
  resultsPath: "warehouses.*.zones.*.bins",
  drillResultsPath: "availability",
  joinFields: ["binId"],
};

describe("resolveApplicableFoldPlans — declared foldReturn joinFields on a double-wildcard nested resultsPath", () => {
  it("resolves the fold plan target's joinFields to the declared binId, not the structurally-guessed warehouseId/zoneId", () => {
    const actionSteps = buildDoubleWildcardDrillDownSteps();

    const plans = resolveApplicableFoldPlans(actionSteps, SPEC, undefined, undefined);

    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan!.targets.length).toBeGreaterThan(0);
    for (const target of plan!.targets) {
      expect(JSON.stringify(target.joinFields)).toBe(JSON.stringify(SPEC.joinFields));
      expect(target.joinFields).not.toContain("warehouseId");
      expect(target.joinFields).not.toContain("zoneId");
    }
  });
});
