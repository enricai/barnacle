import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";

const BASE = "https://api.example.com";

/**
 * Same coverage as
 * recon-generate-frozen-varying-drill-param-hard-fail.test.ts's
 * "correlated sibling body field" cases, but routed through
 * `emitContractTs`'s `parameterizeUrl` — the second
 * `assertNoFrozenVaryingDrillParams` consumer named in
 * docs/recon-generate-nested-fold-flatmaps-away-the-parent-so-drill-params-freeze.md
 * suggested fix #2, mirroring
 * recon-generate-frozen-varying-drill-param-contract-hard-fail.test.ts.
 */

function searchCapture(page: number, pageHistory: string): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/search?page=1`,
    status: 200,
    requestHeaders: {},
    requestPostData: JSON.stringify({ page, pageHistory }),
    responseHeaders: {},
    responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/**
 * The `markN` query param is an always-distinct-by-key, never-shared-across-
 * captures marker (no sibling capture of this endpoint ever carries the
 * SAME key, so {@link findFrozenVaryingDrillParams}'s query-param loop
 * never sees it "differ" and never flags it on its own). It exists purely
 * so the capture's rendered URL text — the only text `emitContractTs`'s
 * `parameterizeUrl` ever passes to the frozen-varying-param guard, since
 * this emitter never renders a request body for a drill fetch — literally
 * contains `page`'s own digit, the same coincidental-substring mechanism
 * {@link findFrozenVaryingDrillParams}'s own doc comment calls out (a
 * `children=0` query param coincidentally matching an unrelated `discount`
 * value). Without it, `page`/`pageHistory` would only ever live in
 * `requestPostData`, which emitContractTs's chain fetch never renders, so
 * the guard could never see the body field's literal at all — the test
 * would trivially not-throw regardless of whether the fix is present.
 */
function pricingDrillCapture(sku: string, page: number, pageHistory: string, ts: string): unknown {
  return {
    timestamp: ts,
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/pricing/?sku=${sku}&mark${page}=ok`,
    status: 200,
    requestHeaders: {},
    requestPostData: JSON.stringify({ page, pageHistory }),
    responseHeaders: {},
    responseBody: { results: [{ sku, amount: 19.99 }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "results",
  joinFields: ["sku"],
};

function buildActionSteps(captures: unknown[]): ReturnType<typeof compileActionSteps> {
  const actionCaptures = extractGraphQLActionSequence(captures as never[], null, SPEC);
  const stateIndex = indexStateValues(
    captures as never[],
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  return compileActionSteps(actionCaptures, stateIndex);
}

function buildContract(
  actionSteps: ReturnType<typeof compileActionSteps>,
  primaryCapture: unknown
): string {
  const primary = primaryCapture as { responseBody: unknown };
  return emitContractTs({
    siteId: "frozen-varying-drill-param-contract-lockstep-correlation-test",
    pascal: "FrozenVaryingDrillParamContractLockstepCorrelationTest",
    baseUrl: BASE,
    baseHeaders: {},
    minTime: 100,
    safeRps: 10,
    responseBody: primary.responseBody,
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

describe("emitContractTs — frozen-but-varying drill param lockstep-correlation regression", () => {
  it("does not throw when a varying body field is a deterministic function of a correlated sibling field", () => {
    const primary = searchCapture(1, "p1");
    const actionSteps = buildActionSteps([
      primary,
      pricingDrillCapture("sku-a", 1, "p1", "2024-01-01T00:00:01Z"),
      pricingDrillCapture("sku-b", 2, "p1,p2", "2024-01-01T00:00:02Z"),
    ]);
    expect(() => buildContract(actionSteps, primary)).not.toThrow();
  });

  it("still throws naming the body field when no sibling field explains why it varies", () => {
    const primary = searchCapture(1, "p1");
    const actionSteps = buildActionSteps([
      primary,
      pricingDrillCapture("sku-a", 1, "p1", "2024-01-01T00:00:01Z"),
      pricingDrillCapture("sku-b", 2, "p1", "2024-01-01T00:00:02Z"),
    ]);
    expect(() => buildContract(actionSteps, primary)).toThrow(/page/);
  });
});
