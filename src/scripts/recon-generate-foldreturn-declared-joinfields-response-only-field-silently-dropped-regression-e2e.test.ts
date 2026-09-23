import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * ROOT CAUSE (diagnosis only — no production fix in this change):
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
 * `buildFoldPlanFromSpec` (src/scripts/recon-generate.ts:9602), by contrast,
 * returns AT MOST ONE `FoldPlan | null` — its `primaryStepIndex` loop
 * (src/scripts/recon-generate.ts:9613-9617) keeps unconditionally
 * overwriting a single `freshestPlan` variable (assigned at
 * src/scripts/recon-generate.ts:9749) with whichever primary occurrence it
 * resolves LAST, so only the freshest occurrence (`r2`, index 2) ever gets a
 * spec-resolved plan; the earlier occurrence (`r0`, index 0) has no spec
 * plan of its own at all.
 *
 * `mergeSpecPlanOntoSamePrimary` (src/scripts/recon-generate.ts:9838) then
 * merges this SINGLE `specPlan` against the structural plans via
 * `samePrimaryPlan` (src/scripts/recon-generate.ts:9860), found by exact
 * `primaryStepIndex` equality — it matches the `r2`-anchored structural
 * plan (index 2) only. The override happens inside
 * `structuralPlans.map(...)` (src/scripts/recon-generate.ts:9896-9897),
 * which touches ONLY the matched `samePrimaryPlan` entry and returns every
 * OTHER structural plan verbatim (`if (plan !== samePrimaryPlan) return
 * plan;`). The `r0`-anchored plan is therefore never even considered for
 * override — not because it falls through the `sameIdentityPlan` guard's
 * `return [...structuralPlans]` at line 10023 (that path is never reached
 * here; `samePrimaryPlan` is found), but because `mergeSpecPlanOntoSamePrimary`
 * only ever addresses the ONE structural plan matching the ONE spec plan
 * `buildFoldPlanFromSpec` chose to resolve, silently leaving every earlier
 * re-issued-primary occurrence's structurally-guessed `joinFields` intact.
 *
 * Confirmed by direct probe against this exact fixture shape: the FIRST
 * search occurrence's emitted fold-match (`foldMatch0`, folding `r1`) still
 * keys on the structural heuristic's own guessed `code`/`summary.currency`/
 * `summary.taxIncluded` fields; only the SECOND occurrence's fold-match
 * (`foldMatch1`, folding `r3`) keys on the declared `widgetId`.
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
    // matches, not just the freshest one `buildFoldPlanFromSpec` happened to
    // resolve last (src/scripts/recon-generate.ts:9613-9749).
    expect(body.match(/m\["widgetId"\]/g)?.length).toBe(2);
    // The structural heuristic's own guessed fields must never survive as
    // the emitted match key on EITHER occurrence — currently the earlier
    // (`r0`-anchored) occurrence still keys on these, because
    // `mergeSpecPlanOntoSamePrimary`'s `samePrimaryPlan` branch
    // (src/scripts/recon-generate.ts:9860-9897) only overrides the ONE
    // structural plan matching the single spec-resolved plan's
    // `primaryStepIndex`, leaving every other re-issued occurrence's
    // structural guess untouched.
    expect(body).not.toContain('m["code"]');
    expect(body).not.toContain('summary"] as Record<string, unknown>)?.["currency"]');
    expect(body).not.toContain('summary"] as Record<string, unknown>)?.["taxIncluded"]');
  });
});
