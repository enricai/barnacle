import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractActionSequence,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * End-to-end regression for the doc's actual reproduction: a same-origin,
 * query-less widget that varies BOTH its request body and its
 * non-URL-derivable, business-looking JSON response on every fire must
 * never survive into the fold plan or the emitted contract's primary
 * operation, even though it fires far more often than the real search
 * endpoint it would otherwise outrecur. Runs the generator's own
 * extractActionSequence/indexStateValues/compileActionSteps/emitContractTs
 * pipeline (not the isolated isZeroVarianceRepeatCapture predicate feat-001
 * covers) against a synthetic archive shaped like the report: one real
 * search POST, one real per-item drill GET, and 12 widget fires.
 */

const BASE = "https://api.example.com";
const SEARCH_URL = `${BASE}/catalog/search`;
const DRILL_URL = `${BASE}/catalog/details`;
const WIDGET_URL = `${BASE}/widget/render`;

const FOLD_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/details",
  resultsPath: "results",
  drillResultsPath: "detail",
  joinFields: ["sku"],
};

function searchCapture() {
  return buildCapture({
    url: SEARCH_URL,
    requestPostData: JSON.stringify({ page: 1 }),
    responseBody: {
      results: [
        { sku: "item-a", name: "Item A" },
        { sku: "item-b", name: "Item B" },
      ],
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
}

function drillCapture() {
  return buildCapture({
    url: `${DRILL_URL}?sku=item-a`,
    method: "GET",
    requestPostData: null,
    responseBody: { detail: [{ sku: "item-a", climate: "temperate" }] },
    timestamp: "2026-01-01T00:00:01Z",
  });
}

// Query-less: no query string at all, so isZeroVarianceRepeatCapture's
// query-less branch is the one under test. The request body carries a
// per-call nonce (never byte-identical across occurrences) and the JSON
// response carries a per-occurrence-varying, non-URL-derivable value
// (`renderToken`) that never repeats — the exact shape
// hasFreelyVaryingResponseAcrossOccurrences exists to catch, wired into
// this branch by the fix under regression.
const WIDGET_FIRE_COUNT = 12;

function widgetCaptures() {
  return Array.from({ length: WIDGET_FIRE_COUNT }, (_, i) =>
    buildCapture({
      url: WIDGET_URL,
      requestPostData: JSON.stringify({ nonce: `nonce-${i}-${Math.random()}` }),
      responseBody: { renderToken: `render-${i}-${Math.random()}`, widgetVariant: `v${i}` },
      timestamp: `2026-01-01T00:01:${String(i).padStart(2, "0")}Z`,
    })
  );
}

describe("varying-body same-origin noise widget never wins fold-plan/primary-operation selection", () => {
  it("excludes the widget from the extracted action sequence and keeps the real search endpoint primary", () => {
    const search = searchCapture();
    const drill = drillCapture();
    const widgets = widgetCaptures();
    const allCaptures = [...widgets, search, drill] as never[];

    const actionCaptures = extractActionSequence(allCaptures, null, FOLD_SPEC);

    // The widget must never reach the fold pipeline at all.
    expect(actionCaptures).toHaveLength(2);
    expect(
      actionCaptures.some(
        (a) => (allCaptures[a.index] as { url: string } | undefined)?.url === WIDGET_URL
      )
    ).toBe(false);

    const stateIndex = indexStateValues(
      allCaptures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);

    const contract = emitContractTs({
      siteId: "varying-body-noise-fold-plan-primary-regression-test",
      pascal: "VaryingBodyNoiseFoldPlanPrimaryRegressionTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: search.responseBody,
      gql: false,
      gqlQuery: null,
      endpointPath: "/catalog/search",
      gqlOperationName: null,
      gqlVariables: null,
      auxFiles: [],
      actionSteps,
      foldReturnSpec: FOLD_SPEC,
    });

    // The compiled fold plan and the emitted contract's primary operation
    // must both resolve to the real search endpoint, never the widget.
    expect(contract).toContain("/catalog/search");
    expect(contract).toContain("/catalog/details");
    expect(contract).not.toContain("/widget/render");
    expect(contract).not.toContain("renderToken");
    expect(contract).not.toContain("widgetVariant");
  });
});
