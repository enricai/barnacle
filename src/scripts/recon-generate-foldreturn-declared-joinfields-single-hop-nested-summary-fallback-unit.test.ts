import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A single-hop drill-down (no intermediate chain hop) where the drill
 * endpoint is captured TWICE at the same identity — `r1`, a plain lookup,
 * and `r2`, a "refresh" re-query. The structural heuristic threads `code`
 * from the primary item into `r1`'s URL path segment and resolves its own
 * target's `drillStepIndex` there. A declared `foldReturn.joinFields:
 * ["reservationId"]` names a field that threads through no request, so
 * `buildFoldPlanFromSpec` can only resolve it against a drill RESPONSE and
 * tries the freshest occurrence (`r2`) first — landing at a DIFFERENT
 * `drillStepIndex` than the structural heuristic's. Every candidate row
 * (across both occurrences) also carries an identical nested
 * `minimumPriceSummary: { currency, taxIncluded }` sub-object — the exact
 * generic shape a structural fallback would reach for once `code` isn't
 * present on the drill response — so this locks that the emitted `.find()`
 * always keys on the declared `reservationId` and never on that nested
 * summary fallback, for a single-hop drill.
 */
function buildSingleHopDualOccurrenceActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/cruises/search/",
      requestPostData: '{"region":"caribbean"}',
      responseBody: {
        sailings: [
          {
            code: "cx-1",
            reservationId: "res-77",
            minimumPriceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/cruises/pricing/cx-1/",
      requestPostData: '{"lookup":true}',
      responseBody: {
        pricedSailings: [
          {
            reservationId: "decoy-1",
            minimumPriceSummary: { currency: "USD", taxIncluded: true },
          },
          {
            reservationId: "decoy-2",
            minimumPriceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      },
      timestamp: "2024-04-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/cruises/pricing/cx-1/?refresh=true",
      requestPostData: '{"lookup":true,"refresh":true}',
      responseBody: {
        pricedSailings: [
          {
            reservationId: "decoy-1",
            minimumPriceSummary: { currency: "USD", taxIncluded: true },
          },
          {
            reservationId: "res-77",
            minimumPriceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      },
      timestamp: "2024-04-01T00:00:02Z",
    }),
  ];
}

const SINGLE_HOP_DUAL_OCCURRENCE_SPEC: FoldReturnSpec = {
  endpointPattern: "/cruises/pricing/",
  resultsPath: "sailings",
  drillResultsPath: "pricedSailings",
  joinFields: ["reservationId"],
};

describe("recon-generate foldReturn declared joinFields — single-hop drill with nested price-summary-shaped fallback field", () => {
  it("emits the declared joinFields accessor in the foldMatch .find() condition and never the nested summary fallback", () => {
    const actionSteps = buildSingleHopDualOccurrenceActionSteps();
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
      SINGLE_HOP_DUAL_OCCURRENCE_SPEC
    );

    const findLineMatch = body.match(
      /const foldMatch\d* = foldMatches\d*\.length.*\.find\(\(m\) => [^;]+;/
    );
    expect(findLineMatch).not.toBeNull();
    const findLine = findLineMatch![0];

    expect(findLine).toContain('m["reservationId"]');
    expect(findLine).not.toContain('m["currency"]');
    expect(findLine).not.toContain('m["taxIncluded"]');
    expect(findLine).not.toContain("minimumPriceSummary");
  });
});
