import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildMulticallSingleShotSearchDrillDownBoundConstantParamCoincidentValueActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const BOUND_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/item-quote",
  resultsPath: "results",
  joinFields: ["itemId"],
  drillParamBindings: {
    qty: { payloadField: "qty", type: "int", default: 0 },
  },
};

function emitBody(spec: FoldReturnSpec): string {
  const actionSteps =
    buildMulticallSingleShotSearchDrillDownBoundConstantParamCoincidentValueActionSteps();
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
    spec
  );
}

describe("recon-generate — bound drill param wins over coincidence-threading into an unrelated same-valued field", () => {
  it("emits the payload accessor for the bound param, never an accessor threaded into the unrelated field", () => {
    const body = emitBody(BOUND_SPEC);

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(body).toContain("qty=${payload.qty ?? 0}");
    expect(body).not.toMatch(/\$\{[a-zA-Z0-9_.]*\.discount\}/);
  });
});
