import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * REST-body counterpart to recon-generate-fallback-facet-preference.test.ts's
 * GraphQL-variables case: a plain (non-GraphQL) REST search body whose
 * `filters` string leaf packs `category`/`priceRange` facet segments
 * correlating with the flow's own declared payload fields must have those
 * segments spliced with `payload.<field>`, the same way
 * renderGqlVariablesExpr already does for a GraphQL variables object — not
 * survive as a single opaque `payload.filters` accessor or a frozen literal.
 */

function facetBodyCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "filter-the-catalog",
    method: "POST",
    url: "https://shop.example.com/api/catalog-search",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      filters: "category:kitchen|priceRange:10~50",
    }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { items: [{ id: "sku-1", name: "Item 1" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function emitBody(): string {
  return emitMultiStepExecuteHttp(
    [
      {
        capture: facetBodyCapture(),
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
    [
      { step: "Select 'kitchen' from the Category dropdown", payloadField: "Category" },
      { step: "Enter '10~50' as the Price Range", payloadField: "PriceRange" },
    ]
  );
}

describe("recon-generate — REST body facet-string splice", () => {
  it("splices each correlated facet segment with payload.<field>, not a single opaque payload.filters accessor", () => {
    const body = emitBody();

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(body).toContain("${payload.Category}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(body).toContain("${payload.PriceRange}");
    expect(body).not.toContain("category:kitchen|priceRange:10~50");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(body).not.toContain("${payload.filters}");
  });
});
