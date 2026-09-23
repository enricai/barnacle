import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * ROOT CAUSE (fixed):
 *
 * A search endpoint captured TWICE (a re-issued/paginated primary — `r0`
 * then `r2`, same endpoint identity, each returning a DIFFERENT item) each
 * drives its own per-item drill-down (`r1` for `r0`'s item, `r3` for `r2`'s
 * item). `detectDrillDownFoldPlan` (src/scripts/recon-generate.ts:8896)
 * resolves this as TWO INDEPENDENT structural `FoldPlan`s — one anchored at
 * `primaryStepIndex: 0`, one at `primaryStepIndex: 2` — because its own
 * freshest-wins collapse (`laterCoversEveryCurrentTarget`,
 * src/scripts/recon-generate.ts:9005) only merges two occurrences when they
 * both thread the exact same `drillStepIndex`, which two independently
 * drilled items never do.
 *
 * `buildFoldPlanFromSpec` (src/scripts/recon-generate.ts:9602) previously
 * returned AT MOST ONE `FoldPlan | null` — its `primaryStepIndex` loop kept
 * unconditionally overwriting a single `freshestPlan` variable with whichever
 * primary occurrence it resolved LAST, so only the freshest occurrence
 * (`r2`, index 2) ever got a spec-resolved plan.
 *
 * Fixed by giving `buildFoldPlanFromSpec` an optional `exactPrimaryStepIndex`
 * parameter that restricts its scan to a single occurrence, and having
 * `mergeSpecPlanOntoSamePrimary` (src/scripts/recon-generate.ts:9847) resolve
 * and merge a declared-joinFields override onto EVERY structural plan at its
 * own `primaryStepIndex`, independently, before the original
 * freshest-occurrence-only merge logic runs.
 */
function buildReissuedPrimaryActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/widgets/search/",
      requestPostData: '{"q":"a"}',
      responseBody: {
        widgets: [
          { code: "w-1", widgetId: "wid-1", summary: { currency: "USD", taxIncluded: true } },
        ],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/widgets/detail/w-1/?currency=USD&taxIncluded=true",
      requestPostData: null,
      responseBody: {
        details: [
          { widgetId: "wid-1", summary: { currency: "USD", taxIncluded: true }, price: 100 },
        ],
      },
      timestamp: "2024-04-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/widgets/search/",
      requestPostData: '{"q":"b"}',
      responseBody: {
        widgets: [
          { code: "w-2", widgetId: "wid-2", summary: { currency: "EUR", taxIncluded: false } },
        ],
      },
      timestamp: "2024-04-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: "https://api.example.com/widgets/detail/w-2/?currency=EUR&taxIncluded=false",
      requestPostData: null,
      responseBody: {
        details: [
          { widgetId: "wid-2", summary: { currency: "EUR", taxIncluded: false }, price: 200 },
        ],
      },
      timestamp: "2024-04-01T00:00:03Z",
    }),
  ];
}

const REISSUED_PRIMARY_SPEC: FoldReturnSpec = {
  endpointPattern: "/widgets/detail/",
  resultsPath: "widgets",
  drillResultsPath: "details",
  joinFields: ["widgetId"],
};

describe("recon-generate foldReturn declared joinFields — response-only field silently dropped on a re-issued primary's earlier occurrence", () => {
  it("emits the declared widgetId join key for EVERY occurrence of the re-issued primary, not just the freshest one", () => {
    const actionSteps = buildReissuedPrimaryActionSteps();
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
      REISSUED_PRIMARY_SPEC
    );

    // The declared `widgetId` join must key BOTH re-issued occurrences' fold
    // matches, not just the freshest one.
    expect(body.match(/m\["widgetId"\]/g)?.length).toBe(2);
    // The structural heuristic's own guessed fields must never survive as
    // the emitted match key on EITHER occurrence.
    expect(body).not.toContain('m["code"]');
    expect(body).not.toContain('summary"] as Record<string, unknown>)?.["currency"]');
    expect(body).not.toContain('summary"] as Record<string, unknown>)?.["taxIncluded"]');
  });
});
