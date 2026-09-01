import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildMulticallSingleShotSearchDrillDownConstantParamCoincidentValueActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const QUOTE_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/item-quote",
  resultsPath: "results",
  joinFields: ["itemId"],
};

/**
 * Mirrors the doc's own reproduction (`grep -o 'adults=[^&]*&children=[^&]*'`
 * in docs/recon-generate-drill-not-hoisted-to-ancestor-scope-and-coincidence-
 * threaded-params.md): a drill param whose captured value is constant across
 * every capture of the endpoint (`qty=0` on both drill requests) must be
 * emitted as that literal, never rewritten into an interpolation of an
 * unrelated field that only coincidentally holds the same value in one
 * capture (`discount`, which is 99 for item 1 and 0 for item 2).
 */
function emitBody(): string {
  const actionSteps =
    buildMulticallSingleShotSearchDrillDownConstantParamCoincidentValueActionSteps();
  return emitMultiStepExecuteHttp(
    actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
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
    new Map(),
    null,
    new Map(),
    new Map(),
    new Set(),
    [],
    new Map(),
    new Map(),
    QUOTE_SPEC
  );
}

describe("recon-generate — a constant drill param is not threaded onto an unrelated coincidentally-equal field", () => {
  it("emits the constant param as the literal value, not an interpolated accessor into the unrelated field", () => {
    const body = emitBody();

    const match = body.match(/itemId=[^&"'\s]*&qty=[^&"'\s]*/);
    expect(match).not.toBeNull();
    expect(match?.[0]).toContain("qty=0");
    expect(match?.[0]).not.toContain("discount");

    expect(body).toContain("qty=0");
    expect(body).not.toContain(`$${"{item.discount}"}`);
    expect(body).not.toMatch(/\$\{g\d+[a-zA-Z0-9_.]*\.discount\}/);
  });
});
