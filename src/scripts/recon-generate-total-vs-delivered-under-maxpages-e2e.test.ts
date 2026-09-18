import Bottleneck from "bottleneck";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitContractTs } from "@/scripts/recon-generate";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";

/**
 * Acceptance test for item4 of recon-royalcaribbean-plugin-root-causes.md:
 * when a caller-supplied `maxPages` caps the paging loop before every page
 * has been fetched, the response's server-reported `total` must stay the
 * server's real value, and the count of items actually delivered must be
 * exposed as a separate sibling field — never silently overwriting `total`
 * with however many items happened to make it through the cap.
 */

const BASE = "https://api.example.com";
const SEARCH_QUERY =
  "query catalogSearch($pagination: PaginationInput) { catalog(pagination: $pagination) { total items { id title } } }";

const SERVER_TOTAL = 436;
const PAGE_SIZE = 100;
const MAX_PAGES = 2;
const EXPECTED_DELIVERED = PAGE_SIZE * MAX_PAGES;

function makeItems(count: number, startIndex: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${startIndex + i}`,
    title: `Item ${startIndex + i}`,
  }));
}

/** Recon captured a page size of 100 at capture time. */
function buildContract(): string {
  const primaryResponseBody = {
    catalog: { total: SERVER_TOTAL, items: makeItems(PAGE_SIZE, 0) },
  };
  return emitContractTs({
    siteId: "catalog-total-vs-delivered-maxpages-test",
    pascal: "CatalogTotalVsDeliveredMaxpagesTest",
    baseUrl: BASE,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: true,
    gqlQuery: SEARCH_QUERY,
    endpointPath: "/graphql",
    gqlOperationName: "catalogSearch",
    gqlVariables: { pagination: { count: PAGE_SIZE, skip: 0 } },
    auxFiles: [],
    actionSteps: [],
  });
}

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
    "CATALOGTOTALVSDELIVEREDMAXPAGESTEST_QUERY",
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

/**
 * A fake paginated server exposing exactly 436 real items, whose own
 * `total` field reads 436 on every page — genuinely accurate, unlike the
 * over-paging fixture's inflated total. The caller caps the fetch at
 * maxPages:2 before all 436 have been delivered.
 */
function makeFakeServer() {
  return (_baseUrl: string) =>
    async (
      _operationName: string,
      _query: string,
      variables: Record<string, unknown>
    ): Promise<unknown> => {
      const pagination = variables.pagination as { skip: number; count: number };
      const remaining = Math.max(0, SERVER_TOTAL - pagination.skip);
      const pageCount = Math.min(pagination.count, remaining);
      return {
        catalog: { total: SERVER_TOTAL, items: makeItems(pageCount, pagination.skip) },
      };
    };
}

describe("recon-generate: server total is preserved separately from delivered count under maxPages cap", () => {
  it("reports the server's real total (436) distinct from the delivered count (200) capped by maxPages:2", async () => {
    const contract = buildContract();
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    const executeHttp = evalPaginatedExecuteHttp(executeHttpBody, makeFakeServer());

    const result = await executeHttp(
      { pageSize: PAGE_SIZE, maxPages: MAX_PAGES },
      { baseUrl: BASE }
    );

    const data = result.data as {
      catalog: { total: number; items: unknown[] };
      deliveredCount: number;
      truncated: boolean;
    };

    // The server's own total is never rewritten to match how much was
    // actually delivered under the cap.
    expect(data.catalog.total).toBe(SERVER_TOTAL);

    // The delivered count — a separate sibling field — reflects exactly
    // what the maxPages:2 cap allowed through (2 pages of 100).
    expect(data.deliveredCount).toBe(EXPECTED_DELIVERED);
    expect(data.catalog.items).toHaveLength(EXPECTED_DELIVERED);

    expect(data.deliveredCount).not.toBe(data.catalog.total);
    expect(data.truncated).toBe(true);
  });
});
