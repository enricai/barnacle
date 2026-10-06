import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, renderGqlVariablesExpr } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * A declared navigateTo facet inside an array must be spliced as
 * `payload.<field>` through the same facet-identity source on both surfaces:
 * a REST body and a GraphQL variables object built from the same captured
 * array and the same flow steps. Guards the two from diverging, leaving a
 * hardcoded literal on one side.
 */

const FACET_LITERAL = "widget-x";
const ELEMENT = `${FACET_LITERAL};filterId=urlFriendlyId`;
const ARRAY = [ELEMENT, "widget-static"];
const FLOW_STEPS = [
  { step: "navigate to widget", navigateTo: `/catalog#${FACET_LITERAL}`, payloadField: "slug" },
];
const SPLICE = "`${payload.slug};filterId=urlFriendlyId`";

function restCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "filter-the-catalog",
    method: "POST",
    url: "https://shop.example.com/api/catalog-search",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ ids: ARRAY }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { items: [{ id: "sku-1" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function emitRestBody(): string {
  return emitMultiStepExecuteHttp(
    [
      {
        capture: restCapture(),
        varName: "r0",
        produces: [],
        isMultipart: false,
        isCrossDomain: false,
      },
    ],
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
}

describe("array facet identity parity: GraphQL variables vs REST body", () => {
  it("splices the same payload field into both surfaces and leaves no literal", () => {
    const rest = emitRestBody();
    const gql = renderGqlVariablesExpr({ ids: ARRAY }, undefined, new Set(), [
      { field: "slug", value: FACET_LITERAL, optional: false },
    ]);

    expect(gql).toContain(SPLICE);
    expect(rest).toContain("payload.slug");
    expect(rest).toContain(";filterId=urlFriendlyId");
    expect(gql).not.toContain(ELEMENT);
    expect(rest).not.toContain(ELEMENT);
    expect(rest).not.toContain(FACET_LITERAL);
  });
});
