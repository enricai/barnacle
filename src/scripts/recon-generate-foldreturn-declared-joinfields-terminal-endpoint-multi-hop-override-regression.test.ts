import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression test for the fix in `mergeSpecPlanOntoSamePrimary` that tests a
 * declared `foldReturn.endpointPattern` against `actions[target.chainTerminalIndex]`
 * instead of `actions[target.drillStepIndex]`.
 *
 * TWO independent structural drill-down targets share the same primary
 * (`widgets` array), both matching the declared `endpointPattern` prefix —
 * required because `buildFoldPlanFromSpec`'s freshest-first unrestricted scan
 * always `break`s after the FIRST endpoint it resolves (see its
 * `restrictToDrillEndpointKey` docstring), so only ONE of the two targets can
 * ever be overridden by that plan-level resolution:
 *
 * - Target A (`r3`, `/widgets/lookup-a/`) is a single-hop drill threaded by a
 *   flat `sessionKey` field — its `drillStepIndex` and `chainTerminalIndex`
 *   are the SAME call — and is also the FRESHEST endpointPattern match, so
 *   the plan-level unrestricted spec resolution lands on it directly.
 *
 * - Target B (`r1` -> `r2`) is a chained drill: the structural heuristic
 *   threads the primary item's OWN nested/optional `warehouse.zone` field
 *   (present only under an optional sub-object) into `r1`'s own request
 *   (`drillStepIndex` = `r1`), but `r1`'s response is a flat notification
 *   with no per-item data of its own, so `computeFoldChain` advances the
 *   terminal to `r2` (`chainTerminalIndex` = `r2`) — the call the declared
 *   `endpointPattern` actually names and where the real `widgetId`
 *   identifier lives. Because the plan-level unrestricted resolution already
 *   broke on target A, target B's override depends ENTIRELY on the
 *   per-target restricted fallback this subtask locks in. Before the fix,
 *   that fallback tested the declared pattern against `r1` (the entry hop,
 *   never matches) instead of `r2` (the terminal, matches), so target B kept
 *   its structurally-guessed nested `warehouse.zone` join key.
 */
function buildTerminalEndpointMultiHopActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/widgets/search/",
      requestPostData: '{"category":"tools"}',
      responseBody: {
        items: [{ widgetId: "W1", sessionKey: "SK1", warehouse: { zone: "Z9" } }],
      },
      timestamp: "2024-05-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/widgets/notify/?zone=Z9",
      requestPostData: null,
      responseBody: { notified: true },
      timestamp: "2024-05-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("r2", {
      url: "https://api.example.com/widgets/lookup-b/",
      requestPostData: JSON.stringify({ notified: true }),
      responseBody: {
        widget: [{ widgetId: "W1", total: 42 }],
      },
      timestamp: "2024-05-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: "https://api.example.com/widgets/lookup-a/?key=SK1",
      requestPostData: null,
      responseBody: {
        widget: [{ widgetId: "W1", price: 99 }],
      },
      timestamp: "2024-05-01T00:00:03Z",
      method: "GET",
    }),
  ];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/widgets/lookup-",
  resultsPath: "items",
  drillResultsPath: "widget",
  joinFields: ["widgetId"],
};

describe("recon-generate foldReturn declared joinFields — chain terminal vs threading-entry override", () => {
  it("overrides the structurally-guessed nested warehouse.zone join key with the declared widgetId on the chained target, even though the spec's own unrestricted resolution already landed on the OTHER (single-hop) target", () => {
    const actionSteps = buildTerminalEndpointMultiHopActionSteps();
    const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      SPEC
    );

    // Both targets must end up matching by the declared widgetId — the
    // chained target (r1 -> r2) must not be left on its structural nested
    // warehouse.zone guess just because the spec's own unrestricted
    // resolution already broke on the other (single-hop) target.
    expect(body.match(/m\["widgetId"\]/g)?.length).toBe(2);
    expect(body).not.toContain('m["warehouse.zone"]');
    expect(body).not.toContain('m["zone"]');

    // Exactly one drill target/URL was emitted per structural hop — no
    // duplicate target competing for the same chain.
    expect(body.match(/const foldMatches\w* =/g)?.length).toBe(2);
    expect(body.match(/\$\{payload\.BaseUrl\}\/widgets\/lookup-b\//g)?.length).toBe(1);
    expect(body.match(/\$\{payload\.BaseUrl\}\/widgets\/lookup-a\//g)?.length).toBe(1);
  });
});
