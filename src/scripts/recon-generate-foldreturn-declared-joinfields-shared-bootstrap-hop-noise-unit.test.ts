import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";

/**
 * The real declared fold's own resolution enters its chain through a
 * shared bootstrap call (`r1`, mints `sessionToken`) — `r1`'s own request
 * literally carries the declared join value (`widget-01`), so
 * `resolveSpecMatchedPrimaryItemIndexAlongChain` resolves its entry there,
 * and `computeFoldChain`'s forward walk from `r1` reaches the real
 * per-item data only at the declared terminal `r3`, giving the spec target
 * a chain of `[r1, r2, r3]`.
 *
 * The archive ALSO contains an entirely unrelated primary/drill pair
 * (`r_noise_primary`, `r1`) whose own item field (`widgetId`) is
 * structurally threaded into that SAME `r1` bootstrap call — a plausible
 * real-world coincidence (a shared session/auth endpoint reused by an
 * unrelated feature), not a conflicting declaration of the same fold.
 * `r1` is therefore both the noisy structural plan's own `drillStepIndex`
 * AND an upstream hop the real declared fold's chain merely replays on
 * its way to `r3` — a real chain passing through a step some other,
 * unrelated target folds FROM is not a genuine conflict, so the declared
 * fold must still resolve onto the real `results` primary.
 */
function buildSharedBootstrapHopSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r_noise_primary", {
      url: `${BASE}/widgets/list/`,
      requestPostData: '{"page":1}',
      responseBody: {
        widgets: [{ widgetId: "W1" }],
      },
      timestamp: "2026-01-01T00:00:00Z",
    }),
    buildStep("r_search", {
      url: `${BASE}/catalog/search/`,
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ productId: "widget-01" }],
      },
      timestamp: "2026-01-01T00:00:01Z",
    }),
    buildStep("r1", {
      url: `${BASE}/session/bootstrap/?widgetId=W1&productId=widget-01`,
      requestPostData: '{"scope":"catalog"}',
      responseBody: {
        entries: [{ widgetId: "W1", sessionToken: "sess-token-abcdefgh" }],
      },
      timestamp: "2026-01-01T00:00:02Z",
    }),
    buildStep("r2", {
      url: `${BASE}/catalog/hold/`,
      requestPostData: JSON.stringify({ sessionToken: "sess-token-abcdefgh" }),
      responseBody: { held: true },
      timestamp: "2026-01-01T00:00:03Z",
    }),
    buildStep("r3", {
      url: `${BASE}/catalog/details/`,
      requestPostData: JSON.stringify({ sessionToken: "sess-token-abcdefgh" }),
      responseBody: {
        rows: [{ productId: "widget-01", inStock: true }],
      },
      timestamp: "2026-01-01T00:00:04Z",
    }),
  ];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/details/",
  resultsPath: "results",
  joinFields: ["productId"],
};

describe("resolveFoldPlan — declared joinFields survive an unrelated structural plan sharing a chain bootstrap hop", () => {
  it("still resolves the declared fold onto the real search primary instead of being dropped", () => {
    const actionSteps = buildSharedBootstrapHopSteps();

    const plans = resolveFoldPlan(actionSteps, SPEC, null);

    const specResolvedPlan = plans.find(
      (plan) => plan.primaryArrayPath.length === 1 && plan.primaryArrayPath[0] === "results"
    );

    expect(specResolvedPlan).toBeDefined();
    expect(specResolvedPlan?.targets).toHaveLength(1);
    expect(specResolvedPlan?.targets[0]?.joinFields).toEqual(["productId"]);

    // The unrelated noisy structural plan is unaffected — still present,
    // still resolved by its own field, proving this is additive rather
    // than one plan clobbering the other.
    const noisePlan = plans.find(
      (plan) => plan.primaryArrayPath.length === 1 && plan.primaryArrayPath[0] === "widgets"
    );
    expect(noisePlan).toBeDefined();
    expect(noisePlan?.targets[0]?.joinFields).toEqual(["widgetId"]);
  });
});
