import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A two-level nested primary array (an ancestor loop over `regions[]`, each
 * carrying an item loop over `sites[]`) whose per-item `sites[]` entries
 * carry BOTH `code` (structurally threaded into the drill URL path segment,
 * so the heuristic prefers it) and `variantId` (present on the drill
 * response too, but never threaded through any request, so only the
 * declared `joinFields` can resolve it). The drill response never echoes
 * `code` at all, so a join emitted against it would be a bug the plan-level
 * fix (test-001 of this pair) already prevents at the plan level — this
 * test locks that the fix also reaches the emitted `.find()` source text,
 * not just the resolved plan object.
 */
function buildNestedPrimaryDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/regions/",
      requestPostData: '{"country":"us"}',
      responseBody: {
        regions: [
          {
            name: "west",
            sites: [{ code: "site-1", variantId: "var-9" }],
          },
        ],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/site-details/site-1/",
      requestPostData: '{"lookup":true}',
      responseBody: {
        detail: [{ variantId: "var-9", price: 200 }],
      },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

const NESTED_PRIMARY_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/site-details/",
  resultsPath: "regions.*.sites",
  drillResultsPath: "detail",
  joinFields: ["variantId"],
};

describe("recon-generate foldReturn declared joinFields — emitted accessor for a nested ancestor+item primary array", () => {
  it("emits the declared joinFields accessor in the foldMatch .find() condition and never the absent structurally-preferred field", () => {
    const actionSteps = buildNestedPrimaryDrillDownActionSteps();
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
      NESTED_PRIMARY_SPEC
    );

    const findLineMatch = body.match(
      /const foldMatch\d* = foldMatches\d*\.length.*\.find\(\(m\) => [^;]+;/
    );
    expect(findLineMatch).not.toBeNull();
    const findLine = findLineMatch![0];

    expect(findLine).toContain('m["variantId"]');
    expect(findLine).not.toContain('m["code"]');
  });
});
