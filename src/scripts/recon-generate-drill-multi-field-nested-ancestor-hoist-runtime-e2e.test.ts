import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
  resolveFoldPlan,
} from "@/scripts/recon-generate";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";

const BASE = "https://api.example.com";

/**
 * Closes the untested combination from
 * recon-generate-drill-threads-per-item-scope-defeating-per-ancestor-hoist.md:
 * a PAGED primary (buildPaginatedGqlExecuteHttpBody's own bounded-paging
 * loop, per recon-generate-graphql-paginated-fetch-loop.test.ts) whose fold
 * drill threads TWO varying params — one item-literal-matched against a
 * one-level ancestor field (`g0.code`), one item-literal-matched against a
 * TWO-level-nested ancestor field (`g0.meta.flagship.code`) — must still
 * hoist the drill fetch to the per-ancestor (paginated-group) loop, not the
 * per-item (entry) loop, exactly as the non-paginated single-field/single-
 * depth case already does (see
 * recon-generate-contract-dual-scope-coincident-drill-hoist-runtime-e2e.test.ts).
 */

const SEARCH_QUERY =
  "query catalogSearch($pagination: PaginationInput) { catalog(pagination: $pagination) { total sections { code meta { flagship { code } } entries { id code flagCode title } } } }";

function catalogSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      query: SEARCH_QUERY,
      variables: { pagination: { count: 2, skip: 0 } },
    }),
    responseHeaders: {},
    responseBody: {
      data: {
        catalog: {
          total: 2,
          sections: [
            {
              code: "sec1",
              meta: { flagship: { code: "flg1" } },
              entries: [
                { id: "e1", code: "sec1", flagCode: "flg1", title: "Widget" },
                { id: "e2", code: "e2-code", flagCode: "flg1", title: "Gadget" },
                { id: "e3", code: "sec1", flagCode: "flg3-code", title: "Doohickey" },
              ],
            },
            {
              code: "sec2",
              meta: { flagship: { code: "flg2" } },
              entries: [
                { id: "e4", code: "sec2", flagCode: "flg2", title: "Thingamajig" },
                { id: "e5", code: "e5-code", flagCode: "flg2", title: "Contraption" },
                { id: "e6", code: "sec2", flagCode: "flg6-code", title: "Gizmo" },
              ],
            },
          ],
        },
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: { pagination: { count: 2, skip: 0 } },
    decodedParams: null,
  };
}

function entryDetailsCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/details?code=sec1&flag=flg1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      detail: [
        { id: "e1", description: "A widget." },
        { id: "e2", description: "A gadget." },
        { id: "e3", description: "A doohickey." },
      ],
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function decoyDetailsCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:02Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/details?code=zzz-unrelated&flag=zzz-unrelated-flag`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ id: "zzz-unrelated", description: "An unrelated entry." }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const ENTRY_DETAILS_SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/details",
  resultsPath: "data.catalog.sections.*.entries",
  drillResultsPath: "detail",
  joinFields: ["id"],
};

function jsonResponse(body: unknown): {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  headers: Headers;
} {
  return {
    status: 200,
    ok: true,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Headers(),
  };
}

function stubSequentialFetch(bodies: unknown[]): void {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce(jsonResponse(body));
  }
  vi.stubGlobal("fetch", fn);
}

function evalSinglePrimaryExecuteHttp(
  body: string,
  getGql: (
    baseUrl: string
  ) => (
    operationName: string,
    query: string,
    variables: Record<string, unknown>
  ) => Promise<unknown>,
  httpClient: ReturnType<typeof createHttpClient>,
  queryConstName: string,
  queryText: string
): (payload: Record<string, unknown>, context: { baseUrl: string }) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const factory = new Function(
    "getGql",
    "httpClient",
    "z",
    queryConstName,
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
  return factory(getGql, httpClient, z, queryText);
}

function buildContract(): string {
  const captures = [
    catalogSearchCapture(),
    entryDetailsCapture(),
    decoyDetailsCapture(),
  ] as never[];

  const actionCaptures = extractGraphQLActionSequence(captures, null, ENTRY_DETAILS_SPEC);
  const stateIndex = indexStateValues(
    captures,
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);

  const foldPlans = resolveFoldPlan(actionSteps, ENTRY_DETAILS_SPEC);
  expect(foldPlans.length).toBeGreaterThan(0);

  const primaryResponseBody = actionSteps[0]!.capture.responseBody;

  return emitContractTs({
    siteId: "paged-drill-multi-field-nested-ancestor-hoist-test",
    pascal: "PagedDrillMultiFieldNestedAncestorHoistTest",
    baseUrl: BASE,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: true,
    gqlQuery: SEARCH_QUERY,
    endpointPath: "/graphql",
    gqlOperationName: "catalogSearch",
    gqlVariables: { pagination: { count: 2, skip: 0 } },
    auxFiles: [],
    actionSteps,
    foldReturnSpec: ENTRY_DETAILS_SPEC,
  });
}

describe("emitContractTs — paged primary + dual scope-coincident, multi-depth drill params both hoist to the ancestor binding", () => {
  it("emits a bounded paging loop AND places the drill fetch call site between the ancestor and item loop opens, referencing only ancestor bindings", () => {
    const contract = buildContract();

    // The primary read is still a bounded paging loop (buildPaginatedGqlExecuteHttpBody), not
    // collapsed to a single fixed-page call by the fold's presence.
    expect(contract).toContain("const PAGE_SIZE = 2;");
    expect(contract).toContain("const itemsById = new Map<");

    // #330/#339 dedup guard: still exactly one httpClient call, textually.
    expect(contract).toContain("getGql(context.baseUrl)(");
    expect((contract.match(/await httpClient\(/g) ?? []).length).toBe(1);

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    // The paginated fetch loop's own page-merge also contains a `for (const item of
    // page....sections)` line, ahead of the fold's ancestor loop — anchor the
    // ancestor/item indices from `groupLoopIndex` onward so that unrelated loop isn't
    // mistaken for the fold's own item loop.
    const groupLoopIndex = executeHttpBody.indexOf("for (const g0 of");
    const drillFetchCallIndex = executeHttpBody.indexOf(
      "/listings/api/v1/details?code=",
      groupLoopIndex
    );
    const itemLoopIndex = executeHttpBody.indexOf("for (const item of", groupLoopIndex);

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillFetchCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeLessThan(itemLoopIndex);
    expect(executeHttpBody).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      "/listings/api/v1/details?code=${g0.code}&flag=${g0.meta.flagship.code}"
    );
    expect(executeHttpBody).not.toContain("${item");

    // The per-item (entry) loop body must contain only the join/merge lines — no fetch.
    const itemLoopBody = executeHttpBody.slice(itemLoopIndex);
    expect(itemLoopBody).not.toContain("await httpClient(");
  });

  it("at runtime, calls the drill endpoint exactly once per paginated group (not once per entry) and merges byte-identically", async () => {
    const contract = buildContract();
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    // Only the two group-scoped drill fetches go through `fetch` — the paginated GraphQL
    // primary is served by `getGql` (and converges after a single page: total === PAGE_SIZE).
    stubSequentialFetch([
      {
        detail: [
          { id: "e1", description: "A widget." },
          { id: "e2", description: "A gadget." },
          { id: "e3", description: "A doohickey." },
        ],
      },
      {
        detail: [
          { id: "e4", description: "A thingamajig." },
          { id: "e5", description: "A contraption." },
          { id: "e6", description: "A gizmo." },
        ],
      },
    ]);

    const primaryPage = (catalogSearchCapture() as { responseBody: unknown }).responseBody;
    const gqlCalls: { operationName: string; query: string; variables: unknown }[] = [];
    const getGql =
      (_baseUrl: string) =>
      async (operationName: string, query: string, variables: Record<string, unknown>) => {
        gqlCalls.push({ operationName, query, variables });
        return primaryPage;
      };

    const executeHttp = evalSinglePrimaryExecuteHttp(
      executeHttpBody,
      getGql,
      httpClient,
      "PAGEDDRILLMULTIFIELDNESTEDANCESTORHOISTTEST_QUERY",
      SEARCH_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    // Single page is sufficient (total === PAGE_SIZE), so the paging loop converges on its
    // first fetch — the fold's own drill calls are entirely separate (`fetch`, not `getGql`).
    expect(gqlCalls).toHaveLength(1);

    expect(result.data).toEqual({
      data: {
        catalog: {
          total: 2,
          sections: [
            {
              code: "sec1",
              meta: { flagship: { code: "flg1" } },
              entries: [
                {
                  id: "e1",
                  code: "sec1",
                  flagCode: "flg1",
                  title: "Widget",
                  description: "A widget.",
                },
                {
                  id: "e2",
                  code: "e2-code",
                  flagCode: "flg1",
                  title: "Gadget",
                  description: "A gadget.",
                },
                {
                  id: "e3",
                  code: "sec1",
                  flagCode: "flg3-code",
                  title: "Doohickey",
                  description: "A doohickey.",
                },
              ],
            },
            {
              code: "sec2",
              meta: { flagship: { code: "flg2" } },
              entries: [
                {
                  id: "e4",
                  code: "sec2",
                  flagCode: "flg2",
                  title: "Thingamajig",
                  description: "A thingamajig.",
                },
                {
                  id: "e5",
                  code: "e5-code",
                  flagCode: "flg2",
                  title: "Contraption",
                  description: "A contraption.",
                },
                {
                  id: "e6",
                  code: "sec2",
                  flagCode: "flg6-code",
                  title: "Gizmo",
                  description: "A gizmo.",
                },
              ],
            },
          ],
        },
      },
    });

    // Exactly 2 fetches — one drill per paginated group, not one per entry (which would make 6
    // across a 2-group/3-entry fixture) and not only for the coincidentally-matching entry.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0]![0])).toContain("code=sec1");
    expect(String(calls[0]![0])).toContain("flag=flg1");
    expect(String(calls[1]![0])).toContain("code=sec2");
    expect(String(calls[1]![0])).toContain("flag=flg2");
  });
});
