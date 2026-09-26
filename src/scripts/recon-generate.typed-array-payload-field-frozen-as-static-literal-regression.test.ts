import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins the fix for a top-level typed ARRAY payload field (a captured
 * quantity/id breakdown array) never getting a `${JSON.stringify(payload.<key>)}`
 * splice when it isn't a sibling of the object `locateFormEnvelopePath` picks
 * as the "form envelope". `applyStructuredValuePayloadSubstitutions` only ever
 * parameterizes children of that one located object — a search/facet body has
 * no form to envelope-detect, so a richer-in-primitives nested object (here,
 * `filters`) outranks the body root and the sibling array at the root is
 * skipped by every substitution pass, freezing the captured sample verbatim.
 */

const SEARCH_URL = "https://api.example.com/catalog/search/";

describe("recon-generate emitMultiStepExecuteHttp — top-level typed array field not a form-envelope sibling", () => {
  it("splices a payload.<field> JSON.stringify binding for a root-level structured array even when a nested object outranks the root as the located envelope", () => {
    const captures = [
      buildCapture({
        url: SEARCH_URL,
        requestPostData: JSON.stringify({
          quantities: [
            { typeId: 1, count: 2 },
            { typeId: 2, count: 1 },
          ],
          filters: { page: 1, size: 20, sort: "asc", order: "desc" },
        }),
        responseBody: { results: [] },
        timestamp: "2024-09-01T00:00:00Z",
      }),
    ];
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures, new Set(), new Set(), new Map());
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);
    const outDiscoveredStructuredKeys = new Map<string, string>();

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
      outDiscoveredStructuredKeys
    );

    expect(body).toContain("JSON.stringify(payload.quantities)");
    expect(body).not.toContain('"typeId":1');
    expect(body).not.toContain('"typeId":2');
    expect(outDiscoveredStructuredKeys.has("quantities")).toBe(true);
  });
});
