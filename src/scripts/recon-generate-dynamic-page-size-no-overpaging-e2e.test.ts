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
 * Combined acceptance test: the generated PAGE_SIZE must be
 * caller-overridable at runtime (not frozen at the recon-captured value),
 * and the paging loop must never issue a trailing request past the
 * server's actual last page when the server's own `total` doesn't match
 * the count of distinct ids that actually exist.
 */

const BASE = "https://api.example.com";
const SEARCH_QUERY =
  "query catalogSearch($pagination: PaginationInput) { catalog(pagination: $pagination) { total items { id title } } }";

const DISTINCT_ITEM_COUNT = 436;
const INFLATED_TOTAL = 437;
const CAPTURED_PAGE_SIZE = 10;
const OVERRIDE_PAGE_SIZE = 100;

function makeItems(count: number, startIndex: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${startIndex + i}`,
    title: `Item ${startIndex + i}`,
  }));
}

/** Recon captured a page size of 10 at capture time. */
function buildContract(): string {
  const primaryResponseBody = {
    catalog: { total: INFLATED_TOTAL, items: makeItems(CAPTURED_PAGE_SIZE, 0) },
  };
  return emitContractTs({
    siteId: "catalog-dynamic-page-size-no-overpaging-test",
    pascal: "CatalogDynamicPageSizeNoOverpagingTest",
    baseUrl: BASE,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: true,
    gqlQuery: SEARCH_QUERY,
    endpointPath: "/graphql",
    gqlOperationName: "catalogSearch",
    gqlVariables: { pagination: { count: CAPTURED_PAGE_SIZE, skip: 0 } },
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
    "CATALOGDYNAMICPAGESIZENOOVERPAGINGTEST_QUERY",
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
 * A fake paginated server exposing exactly 436 distinct ids, whose own
 * `total` field reads 437 — one more than actually exists, mirroring a
 * server total that overstates the number of distinct ids actually
 * returned. Each page's `count` variable is
 * recorded so the request payload's actual page size can be asserted.
 */
function makeFakeServer(onPagination: (pagination: { skip: number; count: number }) => void) {
  return (_baseUrl: string) =>
    async (
      _operationName: string,
      _query: string,
      variables: Record<string, unknown>
    ): Promise<unknown> => {
      const pagination = variables.pagination as { skip: number; count: number };
      onPagination(pagination);
      const remaining = Math.max(0, DISTINCT_ITEM_COUNT - pagination.skip);
      const pageCount = Math.min(pagination.count, remaining);
      return { catalog: { total: INFLATED_TOTAL, items: makeItems(pageCount, pagination.skip) } };
    };
}

describe("recon-generate: dynamic page-size override with no over-paging", () => {
  it(
    "uses the caller-overridden pageSize (100, not the captured 10) and stops after " +
      "exactly ceil(436/100)=5 requests without a 6th trailing request past the last page",
    async () => {
      const contract = buildContract();
      const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

      const seenPagination: { skip: number; count: number }[] = [];
      const getGql = makeFakeServer((pagination) => {
        seenPagination.push(pagination);
      });
      const executeHttp = evalPaginatedExecuteHttp(executeHttpBody, getGql);

      const result = await executeHttp({ pageSize: OVERRIDE_PAGE_SIZE }, { baseUrl: BASE });

      // (a) the request payload used the override page size, not the
      // captured 10.
      expect(seenPagination.every((p) => p.count === OVERRIDE_PAGE_SIZE)).toBe(true);
      expect(seenPagination.some((p) => p.count === CAPTURED_PAGE_SIZE)).toBe(false);

      // (b) exactly ceil(436/100) = 5 requests — never a 6th trailing
      // request chasing the inflated total=437 past the actual last page.
      expect(seenPagination).toHaveLength(5);
      expect(seenPagination.map((p) => p.skip)).toEqual([0, 100, 200, 300, 400]);

      expect((result.data as { catalog: { items: unknown[] } }).catalog.items).toHaveLength(
        DISTINCT_ITEM_COUNT
      );
      expect((result.data as unknown as { deliveredCount: number }).deliveredCount).toBe(
        DISTINCT_ITEM_COUNT
      );
    }
  );
});
