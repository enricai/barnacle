import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A long (six-capture) drill chain — a search hop followed by four
 * intermediate lookups before the drill endpoint itself — reproducing the
 * report's combination against a plugin-agnostic domain: the primary item
 * carries a compound nested `holdSummary.currency`/`holdSummary.taxIncluded`
 * pair that threads verbatim into the drill endpoint's own query string, so
 * the structural heuristic resolves its `joinFields` guess to that nested
 * pair. Each drill occurrence's items also carry a flat `requestId` field
 * that never threads into any request — it only ever appears in response
 * bodies — so a declared `foldReturn.joinFields: ["requestId"]` names a key
 * the structural heuristic could never infer on its own. The long chain in
 * front of the drill endpoint must not change which field wins: the declared
 * field, not the shared nested-pair structural guess.
 */
function buildLongChainNestedStructuralGuessActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/venues/search/",
      requestPostData: '{"track":"main"}',
      responseBody: {
        venues: [{ venueId: "ven-1", holdSummary: { currency: "USD", taxIncluded: true } }],
      },
      timestamp: "2024-06-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/venues/ven-1/zones/",
      requestPostData: null,
      responseBody: { zoneId: "zone-1" },
      timestamp: "2024-06-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/venues/zones/zone-1/sections/",
      requestPostData: null,
      responseBody: { sectionId: "sec-1" },
      timestamp: "2024-06-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: "https://api.example.com/venues/sections/sec-1/seats/",
      requestPostData: null,
      responseBody: { seatBatchId: "batch-1" },
      timestamp: "2024-06-01T00:00:03Z",
    }),
    buildStep("r4", {
      url: "https://api.example.com/venues/seatholds/ven-1/?currency=USD&taxIncluded=true",
      requestPostData: null,
      responseBody: {
        candidates: [{ requestId: "req-1", currency: "USD", taxIncluded: true, price: 100 }],
      },
      timestamp: "2024-06-01T00:00:04Z",
    }),
    buildStep("r5", {
      url: "https://api.example.com/venues/seatholds/ven-1/?refresh=true",
      requestPostData: null,
      responseBody: {
        candidates: [{ requestId: "req-1", currency: "USD", taxIncluded: true, price: 150 }],
      },
      timestamp: "2024-06-01T00:00:05Z",
    }),
  ];
}

const LONG_CHAIN_NESTED_STRUCTURAL_GUESS_SPEC: FoldReturnSpec = {
  endpointPattern: "/venues/seatholds/",
  resultsPath: "venues",
  drillResultsPath: "candidates",
  joinFields: ["requestId"],
};

function buildEmission(): string {
  const actionSteps = buildLongChainNestedStructuralGuessActionSteps();
  const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;

  return emitMultiStepExecuteHttp(
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
    LONG_CHAIN_NESTED_STRUCTURAL_GUESS_SPEC
  );
}

describe("recon-generate foldReturn declared joinFields — long chain, shared nested-pair structural guess regression", () => {
  it("emits only the declared requestId join key, never the nested holdSummary currency/taxIncluded structural guess, across a six-capture chain", () => {
    const body = buildEmission();

    expect(body).toContain('m["requestId"]');
    expect(body).not.toContain('m["currency"]');
    expect(body).not.toContain('m["taxIncluded"]');
    // Exactly one fold target for the primary — the declared field must
    // override the structural target's joinFields in place, not append a
    // second, redundant fold target for the same endpoint.
    expect(body.match(/const foldMatches/g)?.length).toBe(1);
  });
});
