import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * TWO independent structural drill-down targets on the same primary array,
 * so the declared spec's own unrestricted (freshest-wins) resolution can
 * only ever land on ONE of them (see `buildFoldPlanFromSpec`'s
 * `restrictToDrillEndpointKey` docstring on why an unrestricted call always
 * `break`s after the first endpoint it resolves):
 *
 * - Target A (`r3`, `/orders/lookup-a/`) is a single-hop drill — its own
 *   `drillStepIndex` and `chainTerminalIndex` are the SAME call — and is
 *   also the FRESHEST endpointPattern match, so the plan-level unrestricted
 *   spec resolution lands on it, correctly overriding it via the
 *   `samePrimaryPlan`/`foldTargetDrillIdentity` branch (out of scope here).
 *
 * - Target B (`r1` -> `r2`) is a chained drill: the heuristic threads the
 *   primary item's `sessionToken` directly into `r1`'s own request
 *   (`drillStepIndex` = `r1`), but `r1`'s response is a flat
 *   single-field session confirmation with no per-item data of its own, so
 *   `computeFoldChain` advances the terminal to `r2`
 *   (`chainTerminalIndex` = `r2`), the call the declared `endpointPattern`
 *   actually names and where the real `orderId` identifier lives. Because
 *   the plan-level unrestricted resolution already broke on target A, target
 *   B's override depends ENTIRELY on the per-target restricted fallback this
 *   subtask fixes. Before the fix, that fallback tested the declared
 *   pattern against `r1` (the entry hop, never matches) instead of `r2` (the
 *   terminal, matches), so target B's structurally-guessed `sessionToken`
 *   join key survived unreplaced.
 */
function buildStructuralEntryTerminalDivergenceActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/orders/search/",
      requestPostData: '{"customerId":"c-1"}',
      responseBody: {
        orders: [{ orderId: "ORD1", sessionToken: "TOK1", altToken: "ALT1" }],
      },
      timestamp: "2024-05-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/orders/session/?token=TOK1",
      requestPostData: null,
      responseBody: { sessionId: "sess-1" },
      timestamp: "2024-05-01T00:00:01Z",
      method: "GET",
    }),
    buildStep("r2", {
      url: "https://api.example.com/orders/lookup-b/",
      requestPostData: JSON.stringify({ sessionId: "sess-1" }),
      responseBody: {
        order: [{ orderId: "ORD1", total: 42 }],
      },
      timestamp: "2024-05-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: "https://api.example.com/orders/lookup-a/?alt=ALT1",
      requestPostData: null,
      responseBody: {
        order: [{ orderId: "ORD1", total: 99 }],
      },
      timestamp: "2024-05-01T00:00:03Z",
      method: "GET",
    }),
  ];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/orders/lookup-",
  resultsPath: "orders",
  drillResultsPath: "order",
  joinFields: ["orderId"],
};

describe("recon-generate foldReturn declared joinFields — structural entry-hop vs chain-terminal divergence", () => {
  it("overrides the structurally-guessed sessionToken join key with the declared orderId on the chained target, even though the spec's own unrestricted resolution already landed on the OTHER (single-hop) target", () => {
    const actionSteps = buildStructuralEntryTerminalDivergenceActionSteps();
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

    // Both targets must end up matching by the declared orderId — the
    // chained target (r1 -> r2) must not be left on its structural
    // sessionToken guess just because the spec's own unrestricted
    // resolution already broke on the other (single-hop) target.
    expect(body.match(/m\["orderId"\]/g)?.length).toBe(2);
    expect(body).not.toContain('m["sessionToken"]');
  });
});
