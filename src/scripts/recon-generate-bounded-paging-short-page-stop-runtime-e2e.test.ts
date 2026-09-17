import Bottleneck from "bottleneck";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitContractTs } from "@/scripts/recon-generate";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";

const BASE = "https://api.example.com";
const SEARCH_QUERY =
  "query catalogSearch($pagination: PaginationInput) { catalog(pagination: $pagination) { total items { id title } } }";

function evalPaginatedExecuteHttp(
  body: string,
  getGql: (
    baseUrl: string
  ) => (
    operationName: string,
    query: string,
    variables: Record<string, unknown>
  ) => Promise<unknown>
): (payload: Record<string, unknown>, context: { baseUrl: string }) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const httpClient = createHttpClient({
    schema: z.unknown(),
    bottleneck: new Bottleneck({ maxConcurrent: 1, minTime: 0 }),
    baseHeaders: { "Content-Type": "application/json" },
  });
  const factory = new Function(
    "getGql",
    "httpClient",
    "z",
    "CATALOGPAGINATEDSHORTPAGESTOPRUNTIMETEST_QUERY",
    `return async function executeHttp(payload, context) {\n${stripped}\n};`
  ) as (
    getGqlArg: unknown,
    httpClientArg: unknown,
    zArg: unknown,
    queryArg: string
  ) => (
    payload: Record<string, unknown>,
    context: { baseUrl: string }
  ) => Promise<{ data: unknown }>;
  return factory(getGql, httpClient, z, SEARCH_QUERY);
}

function buildContract(): string {
  const primaryResponseBody = { catalog: { total: 15, items: makeItems(5, 0) } };
  return emitContractTs({
    siteId: "catalog-paginated-short-page-stop-runtime-test",
    pascal: "CatalogPaginatedShortPageStopRuntimeTest",
    baseUrl: BASE,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: true,
    gqlQuery: SEARCH_QUERY,
    endpointPath: "/graphql",
    gqlOperationName: "catalogSearch",
    gqlVariables: { pagination: { count: 5, skip: 0 } },
    auxFiles: [],
    actionSteps: [],
  });
}

function makeItems(count: number, startIndex: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${startIndex + i}`,
    title: `Item ${startIndex + i}`,
  }));
}

describe("buildPaginatedGqlExecuteHttpBody at runtime: stops on a page with no new distinct items", () => {
  it("breaks the loop as soon as a fetched page contributes zero new items, instead of exhausting MAX_PAGES chasing a total that never converges (total=437, only 436 distinct ids)", async () => {
    const contract = buildContract();
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    // 8 distinct items exist across two non-empty pages, but the server's own
    // `total` field claims 10 — a total/distinct-id mismatch, mirroring the
    // total=437-vs-436-distinct-ids scenario in the success criteria. The
    // second page (3 items) is shorter than the page size (5), which is
    // itself the server's signal that nothing is left — the loop stops
    // there instead of issuing a third request chasing the inflated total.
    const pages = [
      { catalog: { total: 10, items: makeItems(5, 0) } },
      { catalog: { total: 10, items: makeItems(3, 5) } },
    ];
    let callCount = 0;
    const getGql = (_baseUrl: string) => async () => {
      const page = pages[callCount];
      callCount += 1;
      return page;
    };

    const executeHttp = evalPaginatedExecuteHttp(executeHttpBody, getGql);
    const result = await executeHttp({}, { baseUrl: BASE });

    // Exactly 2 calls: the initial fetch plus the loop's first iteration
    // (8 items, a short page) — never reaches MAX_PAGES (50) chasing the
    // phantom total, and never issues a third request past the short page.
    expect(callCount).toBe(2);

    expect(
      (result.data as { catalog: { items: unknown[]; total: number } }).catalog.items
    ).toHaveLength(8);
    // The merged envelope's own total is preserved untouched from the
    // server's last response (10), even though the loop stopped before
    // reaching it; delivery and truncation are exposed as sibling fields.
    expect((result.data as { catalog: { total: number } }).catalog.total).toBe(10);
    expect((result.data as unknown as { deliveredCount: number }).deliveredCount).toBe(8);
    expect((result.data as unknown as { truncated: boolean }).truncated).toBe(true);
  });
});
