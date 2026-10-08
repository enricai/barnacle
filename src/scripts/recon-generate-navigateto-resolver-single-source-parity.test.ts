import { describe, expect, it } from "vitest";
import {
  emitMultiStepExecuteHttp,
  extractNavigateToFacetOrder,
  renderGqlVariablesExpr,
  resolveRecurringNavigateToFacets,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const FLOW_STEPS = [
  { step: "open widget", navigateTo: "/catalog#widget-x", payloadField: "slug" },
  { step: "open region", navigateTo: "/catalog#region-eu", payloadField: "region" },
];
const BODY = { ids: ["widget-x;a=1", "widget-x;a=2"], area: "region-eu" };

function capture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "search",
    method: "POST",
    url: "https://shop.example.com/api/search",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify(BODY),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { items: [{ id: "sku-1" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

describe("resolved navigateTo facets drive both renderers identically", () => {
  it("binds every recurring facet and splices the same fields on REST and GraphQL", () => {
    const action = {
      capture: capture(),
      varName: "r0",
      produces: [],
      isMultipart: false,
      isCrossDomain: false,
    };
    const facets = resolveRecurringNavigateToFacets(extractNavigateToFacetOrder(FLOW_STEPS), [
      action,
    ]);
    expect(facets.map(({ field }) => field)).toEqual(["slug", "region"]);

    const gql = renderGqlVariablesExpr(BODY, undefined, new Set(), facets);
    const rest = emitMultiStepExecuteHttp(
      [action],
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://shop.example.com",
      new Map(),
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      null,
      null,
      FLOW_STEPS
    );
    for (const surface of [gql, rest]) {
      expect(surface).toContain("payload.slug");
      expect(surface).toContain("payload.region");
      expect(surface).not.toContain("widget-x");
      expect(surface).not.toContain("region-eu");
    }
  });
});
