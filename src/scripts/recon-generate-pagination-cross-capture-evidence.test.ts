import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Direct-call counterpart to the runtime e2e coverage: proves
 * `emitContractTs` itself emits the bounded paging loop when the selected
 * primary capture is a partial page but `allCaptures` carries a same-
 * operation sibling whose own response/variables independently satisfy the
 * `% pageSize` check — see `detectPaginationSignal` in recon-generate.ts.
 * Domain-neutral fixture (a generic product-search operation) — not tied to
 * any site or plugin.
 */

const SEARCH_QUERY =
  "query productSearch($filters: FilterInput) { productSearch(filters: $filters) { total items { id name } } }";
const ENDPOINT_PATH = "/graphql";
const BASE_URL = "https://catalog-example.example.com";

function makeItems(count: number, offset: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${offset + i}`,
    name: `Item ${offset + i}`,
  }));
}

function capture(overrides: Partial<Capture>): Capture {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE_URL}${ENDPOINT_PATH}`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: null,
    responseHeaders: {},
    responseBody: null,
    operationName: "productSearch",
    query: SEARCH_QUERY,
    variables: null,
    decodedParams: null,
    ...overrides,
  };
}

/** The selected primary: a partial/last page — 4 items against a
 * pageSize-10 variable, so `4 % 10 !== 0` fails the direct check. */
function partialPagePrimary(): { responseBody: unknown; gqlVariables: unknown } {
  return {
    responseBody: { productSearch: { total: 24, items: makeItems(4, 21) } },
    gqlVariables: { filters: { count: 10, skip: 20 } },
  };
}

/** A same-identity (same endpointPath + operationName) sibling capture whose
 * own response/variables satisfy the `% pageSize` check unassisted — the
 * cross-capture proof `detectPaginationSignal` must consult. */
function fullPageSiblingCapture(): Capture {
  return capture({
    timestamp: "2024-01-01T00:00:01Z",
    variables: { filters: { count: 10, skip: 0 } },
    responseBody: { productSearch: { total: 24, items: makeItems(10, 1) } },
  });
}

/** A different operation that also independently satisfies the full-page
 * check — must not be mistaken for evidence about `productSearch`. */
function differentOperationFullPageCapture(): Capture {
  return capture({
    timestamp: "2024-01-01T00:00:02Z",
    operationName: "featuredProducts",
    query:
      "query featuredProducts($filters: FilterInput) { featuredProducts(filters: $filters) { total items { id name } } }",
    variables: { filters: { count: 10, skip: 0 } },
    responseBody: { featuredProducts: { total: 24, items: makeItems(10, 1) } },
  });
}

function baseOpts(allCaptures: readonly Capture[]): Parameters<typeof emitContractTs>[0] {
  const { responseBody, gqlVariables } = partialPagePrimary();
  return {
    siteId: "catalog-example",
    pascal: "CatalogExample",
    baseUrl: BASE_URL,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody,
    gql: true,
    gqlQuery: SEARCH_QUERY,
    endpointPath: ENDPOINT_PATH,
    gqlOperationName: "productSearch",
    gqlVariables,
    allCaptures,
    auxFiles: [],
  };
}

describe("emitContractTs — cross-capture pagination-signal recovery", () => {
  it("emits the bounded paging loop when a same-operation sibling proves pagination for a partial-page primary", () => {
    const source = emitContractTs(
      baseOpts([fullPageSiblingCapture(), differentOperationFullPageCapture()])
    );

    expect(source).toContain("const PAGE_SIZE = 10;");
    expect(source).toContain("MAX_PAGES");
    expect(source).toContain("itemsById");
  });

  it("falsifier: stays a single fixed-page executeHttp when no same-operation sibling proves pagination (control)", () => {
    const source = emitContractTs(baseOpts([differentOperationFullPageCapture()]));

    expect(source).not.toContain("const PAGE_SIZE = 10;");
    expect(source).not.toContain("MAX_PAGES");
  });
});
