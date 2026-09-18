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
 * Regression test for the `payload.pageSize`-overridable `PAGE_SIZE`
 * initializer (recon-generate.ts:10441). Proves all three parts of the
 * contract: the emitted payload schema accepts an optional `pageSize`, a
 * caller-supplied larger `pageSize` measurably reduces paging requests
 * against a mock endpoint, and omitting it reproduces today's frozen
 * capture-time default (no regression on the default path).
 */

const BASE = "https://api.example.com";
const SEARCH_QUERY =
  "query catalogSearch($pagination: PaginationInput) { catalog(pagination: $pagination) { total items { id title } } }";

function makeItems(count: number, startIndex: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${startIndex + i}`,
    title: `Item ${startIndex + i}`,
  }));
}

function buildContract(): string {
  // Recon captured a page size of 5 at capture time.
  const primaryResponseBody = { catalog: { total: 20, items: makeItems(5, 0) } };
  return emitContractTs({
    siteId: "catalog-page-size-override-regression-test",
    pascal: "CatalogPageSizeOverrideRegressionTest",
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
    "CATALOGPAGESIZEOVERRIDEREGRESSIONTEST_QUERY",
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

/** 20 distinct items total, split into pages of `pageSize` on each call. */
function makeGetGql(pageSize: number, onCall: () => void) {
  const TOTAL = 20;
  return (_baseUrl: string) =>
    async (
      _operationName: string,
      _query: string,
      variables: Record<string, unknown>
    ): Promise<unknown> => {
      onCall();
      const pagination = variables.pagination as { skip: number; count: number };
      const remaining = Math.max(0, TOTAL - pagination.skip);
      const pageCount = Math.min(pagination.count, remaining);
      return { catalog: { total: TOTAL, items: makeItems(pageCount, pagination.skip) } };
    };
}

describe("recon-generate: generated PAGE_SIZE payload override regression", () => {
  it("declares pageSize as an optional payload field", () => {
    const contract = buildContract();
    expect(contract).toMatch(/pageSize\??:\s*z\.(coerce\.)?number\(\)[\w.()]*\.optional\(\)/);
  });

  it("fetches the same 20 items in fewer requests when a larger pageSize is supplied", async () => {
    const contract = buildContract();
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    let overrideCallCount = 0;
    const overrideExecuteHttp = evalPaginatedExecuteHttp(
      executeHttpBody,
      makeGetGql(20, () => {
        overrideCallCount += 1;
      })
    );
    const overrideResult = await overrideExecuteHttp({ pageSize: 20 }, { baseUrl: BASE });

    let defaultCallCount = 0;
    const defaultExecuteHttp = evalPaginatedExecuteHttp(
      executeHttpBody,
      makeGetGql(5, () => {
        defaultCallCount += 1;
      })
    );
    const defaultResult = await defaultExecuteHttp({}, { baseUrl: BASE });

    expect((overrideResult.data as { catalog: { items: unknown[] } }).catalog.items).toHaveLength(
      20
    );
    expect((defaultResult.data as { catalog: { items: unknown[] } }).catalog.items).toHaveLength(
      20
    );

    // A pageSize of 20 fetches everything in a single request; the
    // capture-time default of 5 needs 4 — strictly fewer requests.
    expect(overrideCallCount).toBe(1);
    expect(defaultCallCount).toBe(4);
    expect(overrideCallCount).toBeLessThan(defaultCallCount);
  });

  it("omitting pageSize reproduces today's exact default page-size behavior", async () => {
    const contract = buildContract();
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const seenPaginationVars: { skip: number; count: number }[] = [];
    const getGql =
      (_baseUrl: string) =>
      async (
        _operationName: string,
        _query: string,
        variables: Record<string, unknown>
      ): Promise<unknown> => {
        const pagination = variables.pagination as { skip: number; count: number };
        seenPaginationVars.push(pagination);
        const remaining = Math.max(0, 20 - pagination.skip);
        const pageCount = Math.min(pagination.count, remaining);
        return { catalog: { total: 20, items: makeItems(pageCount, pagination.skip) } };
      };

    const executeHttp = evalPaginatedExecuteHttp(executeHttpBody, getGql);
    const result = await executeHttp({}, { baseUrl: BASE });

    // Today's frozen default: every request's `count` variable is the
    // recon-captured page size of 5, and skip advances by 5 each time.
    expect(seenPaginationVars.map((v) => v.count)).toEqual([5, 5, 5, 5]);
    expect(seenPaginationVars.map((v) => v.skip)).toEqual([0, 5, 10, 15]);
    expect((result.data as { catalog: { items: unknown[] } }).catalog.items).toHaveLength(20);
  });
});
