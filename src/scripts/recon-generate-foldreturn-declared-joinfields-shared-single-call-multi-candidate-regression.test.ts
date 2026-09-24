import { describe, expect, it } from "vitest";
import { emitContractTs, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";

/**
 * Reproduces the exact shape reported unchanged across three consecutive
 * releases: a primary array nested one level under a single ancestor object
 * (`listings.items`), declared with a plain dotted `resultsPath` that omits
 * the internal array-wildcard notation `findAllObjectArrayFields` would have
 * used structurally. A single shared drill-down call (captured exactly once,
 * never re-issued per item) returns candidates for every listing at once,
 * each carrying the SAME structurally-threaded `region`/`currency` pair
 * (non-discriminating — identical on every candidate) alongside the
 * declared, response-only `recordId` field that alone identifies which
 * candidate belongs to which listing. Without normalizing the declared path
 * against a real response body before comparing it to the structural guess
 * (recon-generate.ts's `resolveDeclaredArrayPath`), every comparison the
 * fold-join merge runs silently fails to match, and the non-discriminating
 * structural guess wins even though `joinFields` was explicitly declared.
 */
const SPEC: FoldReturnSpec = {
  endpointPattern: "/drill",
  resultsPath: "listings.items",
  joinFields: ["recordId"],
};

function buildActionSteps(): {
  capture: ReturnType<typeof buildCapture>;
  varName: string;
  produces: never[];
  isMultipart: boolean;
  isCrossDomain: boolean;
}[] {
  const search = {
    capture: buildCapture({
      url: `${BASE}/catalog/search/`,
      requestPostData: '{"page":1}',
      responseBody: {
        listings: [
          {
            groupId: "g1",
            items: [
              { recordId: "R1", region: "us", currency: "USD" },
              { recordId: "R2", region: "us", currency: "USD" },
            ],
          },
        ],
      },
      timestamp: "2026-01-01T00:00:01Z",
    }),
    varName: "r1",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  const drill = {
    capture: buildCapture({
      url: `${BASE}/drill?region=us&currency=USD`,
      requestPostData: null,
      method: "GET",
      responseBody: {
        candidates: [
          { recordId: "R1", region: "us", currency: "USD", stock: 3 },
          { recordId: "R2", region: "us", currency: "USD", stock: 5 },
        ],
      },
      timestamp: "2026-01-01T00:00:02Z",
    }),
    varName: "r2",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  return [search, drill];
}

function generateContract(siteId: string): string {
  const actionSteps = buildActionSteps();
  return emitContractTs({
    siteId,
    pascal: "FoldreturnSharedSingleCallMultiCandidateRegressionTest",
    baseUrl: BASE,
    baseHeaders: {},
    minTime: 100,
    safeRps: 10,
    responseBody: actionSteps[0]!.capture.responseBody,
    gql: false,
    gqlQuery: null,
    endpointPath: "/catalog/search",
    gqlOperationName: null,
    gqlVariables: null,
    auxFiles: [],
    actionSteps,
    foldReturnSpec: SPEC,
  });
}

describe("recon-generate foldReturn declared joinFields — shared single-call multi-candidate drill response, nested non-wildcard resultsPath (regression)", () => {
  it("emits the declared recordId join key on the fold-match condition, never the shared non-discriminating region/currency structural guess", () => {
    const contract = generateContract(
      `foldreturn-shared-single-call-multi-candidate-regression-${process.pid}`
    );

    expect(contract).toContain('m["recordId"]');
    expect(contract).not.toContain('m["region"]');
    expect(contract).not.toContain('m["currency"]');
    // Exactly one fold target — the shared drill call is folded once per
    // primary listing, not duplicated as a second independent target.
    expect(contract.match(/const foldMatches/g)?.length).toBe(1);
  });
});
