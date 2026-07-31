import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionSteps,
  buildMulticallHeterogeneousActionStepsWithDrillDown,
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
  it("returns the re-queried search step's body, not the terminal drill-down's", () => {
    const body = emit(buildMulticallHeterogeneousActionStepsWithDrillDown());

    // r3 is the last of the two re-queried available-products/ calls; r4 is
    // the terminal available-sailings/ drill-down. Pre-fix (`actions[actions
    // .length-1]`), this would return r4 — the wrong call's body.
    expect(body).toContain("return { data: r3 };");
    expect(body).not.toContain("return { data: r4 };");
    expect(body).toContain("const r3 = (await httpClient(");
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
