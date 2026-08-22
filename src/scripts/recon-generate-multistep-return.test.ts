import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithFoldedDrillDown,
  buildMulticallHeterogeneousActionStepsWithFoldedDrillDownLoop,
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

describe("emitMultiStepExecuteHttp — G1 return-value selection", () => {
  it("folds the terminal drill-down's response onto the primary search results by the declared join field", () => {
    const body = emit(buildMulticallHeterogeneousActionStepsWithFoldedDrillDown());

    // r2 is the primary available-products/ search step whose `products[]`
    // array carries the `productId` join field; r4 is the terminal
    // available-units/ drill-down keyed on that field. A resolved fold plan
    // must loop over r2's array, re-fetch r4 per item, and merge the
    // drill-down's fields onto each item — not discard r4's data the way a
    // bare `selectReturnAction` pick would.
    expect(body).toContain("const r2Items = (r2 as { products: unknown[] }).products");
    expect(body).toContain("for (const r2Item of r2Items) {");
    expect(body).toContain("const r4ByJoin = new Map<string, Record<string, unknown>>();");
    expect(body).toContain("const r4 = (await httpClient(");
    expect(body).toContain("r4ByJoin.set(productIdValue, r4);");
    expect(body).toContain("const r2Merged = r2Items.map((r2Item) => {");
    expect(body).toContain(
      "return { data: { ...(r2 as Record<string, unknown>), products: r2Merged } };"
    );
  });

  it("emits a per-item loop-and-merge for a multi-item primary array, re-fetching the drill-down once per item", () => {
    const body = emit(buildMulticallHeterogeneousActionStepsWithFoldedDrillDownLoop());

    // r2's products[] carries TWO items (p1, p2), each with its own terminal
    // available-units/ drill-down (r4, r5 in the fixture's raw capture set) —
    // the emitted code must be a single loop keyed on the join field's
    // per-item VALUE, not a call per fixture step, so it folds every item
    // regardless of how many drill-downs the capture set recorded.
    expect(body).toContain("const r2Items = (r2 as { products: unknown[] }).products");
    expect(body).toContain("for (const r2Item of r2Items) {");
    expect(body).toContain("const productIdValue = (r2Item as { productId: string }).productId;");
    expect(body).toContain("if (r4ByJoin.has(productIdValue)) continue;");
    expect(body).toContain("const r2Merged = r2Items.map((r2Item) => {");
    expect(body).toContain("return { ...r2Item, ...(r4ByJoin.get(productIdValue) ?? {}) };");
  });

  it("still returns the search step when it is ALSO the terminal call", () => {
    const body = emit(buildMulticallHeterogeneousActionSteps());

    // Same re-queried available-products/ call (r3), now also last in the
    // sequence. Pinning this alongside the drill-down case proves the fix
    // tracks relevance, not merely a shifted position (e.g. "second-to-last").
    expect(body).toContain("return { data: r3 };");
    expect(body).toContain("const r3 = (await httpClient(");
  });

  it("returns the terminal call for a genuine 2-step submission flow with no re-queried endpoint", () => {
    const steps: MulticallFixtureStep[] = [
      {
        varName: "r0",
        produces: [],
        isMultipart: false,
        isCrossDomain: false,
        capture: {
          timestamp: "2024-01-01T00:00:00Z",
          phase: "action",
          method: "POST",
          url: "https://ats.example.com/api/applicants",
          status: 200,
          requestHeaders: { "Content-Type": "application/json" },
          requestPostData: '{"FirstName":"Reginald"}',
          responseHeaders: { "content-type": "application/json" },
          responseBody: { applicantId: "a1" },
          operationName: null,
          query: null,
          variables: null,
          decodedParams: null,
        },
      },
      {
        varName: "r1",
        produces: [],
        isMultipart: false,
        isCrossDomain: false,
        capture: {
          timestamp: "2024-01-01T00:00:01Z",
          phase: "action",
          method: "POST",
          url: "https://ats.example.com/api/applicants/a1/submit",
          status: 200,
          requestHeaders: { "Content-Type": "application/json" },
          requestPostData: '{"confirm":true}',
          responseHeaders: { "content-type": "application/json" },
          responseBody: { success: true },
          operationName: null,
          query: null,
          variables: null,
          decodedParams: null,
        },
      },
    ];

    // Neither endpoint is re-hit with a varying body, so findRequeriedActions
    // returns nothing and selectReturnAction must fall back to the LAST
    // action — not the first, which is selectPayloadAction's fallback. A fix
    // that naively reused selectPayloadAction's fallback would regress this
    // case to `return { data: r0 }`.
    const body = emit(steps);

    expect(body).toContain("return { data: r1 };");
    expect(body).not.toContain("return { data: r0 };");
    expect(body).toContain("const r1 = (await httpClient(");
  });
});
