import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildMulticallSingleShotSearchDrillDownConstantParamCoincidentValueActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const QUOTE_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/item-quote",
  resultsPath: "results",
  joinFields: ["itemId"],
};

/**
 * Regression coverage for a drill request param whose OWN captured value is
 * constant across every capture of the same endpoint (`qty=0` on both
 * items' own drill requests), while an unrelated primary field
 * coincidentally holds that same literal for one item only (`discount: 0`
 * on item 2, `99` on item 1). Matching purely by value equality threads
 * `qty` onto `discount` for item 2 specifically, so the generated call
 * would request a fabricated `qty` reflecting item 2's discount instead of
 * the true constant `qty=0`.
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

describe("recon-generate drill-down fold — a constant drill param is not threaded onto an unrelated field by value coincidence", () => {
  it("keeps the constant param as a literal instead of interpolating the coincidentally-matching field", () => {
    const body = emitBody();

    // The item's own varying join field still threads normally.
    expect(body).toContain(`$${"{item.itemId}"}`);

    // `qty` never varied across the two captured drill requests (always
    // `0`), so it must stay a literal — never rewritten to read the
    // primary's `discount` field, which does vary (0 then 250).
    expect(body).toContain("qty=0");
    expect(body).not.toContain(`$${"{item.discount}"}`);
  });
});
