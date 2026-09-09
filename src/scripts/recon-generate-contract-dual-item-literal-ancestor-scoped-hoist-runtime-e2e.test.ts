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
 * `emitContractTs` must hoist TWO threaded drill params that are each
 * item-literal (matching only the FIRST matched item's own field, never the
 * ancestor's own top-level field) but independently resolvable under two
 * DIFFERENT nested ancestor sub-paths — generalizing
 * recon-generate-contract-item-literal-ancestor-scoped-hoist-runtime-e2e.test.ts's
 * single-param case (and mirroring
 * buildMulticallNestedGroupedDrillDownDualItemLiteralDistinctSubpathAncestorScopedParamsActionSteps's
 * fixture shape) through the real emitContractTs entry point, with a
 * GraphQL primary. A plan that resolves only one of the two nested
 * ancestor sub-paths would still issue a fetch per item instead of per
 * group. Also reasserts the #330/#339 same-endpoint dedup guard.
 */

const SEARCH_QUERY =
  "query catalogSearch { catalog { sections { masterCode primaryVariant { code } cheapestVariant { detail { code } } entries { entryId ownCode ownDetailCode title } } } }";

function catalogSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      data: {
        catalog: {
          sections: [
            {
              masterCode: "grp1",
              primaryVariant: { code: "pv1" },
              cheapestVariant: { detail: { code: "cv1" } },
              entries: [
                { entryId: "e1", ownCode: "pv1", ownDetailCode: "cv1", title: "Widget" },
                { entryId: "e2", ownCode: "pv1-alt", ownDetailCode: "cv1-alt", title: "Gadget" },
                {
                  entryId: "e3",
                  ownCode: "pv1-alt2",
                  ownDetailCode: "cv1-alt3",
                  title: "Doohickey",
                },
              ],
            },
            {
              masterCode: "grp2",
              primaryVariant: { code: "pv2" },
              cheapestVariant: { detail: { code: "cv2" } },
              entries: [
                { entryId: "e4", ownCode: "pv2", ownDetailCode: "cv2", title: "Thingamajig" },
                {
                  entryId: "e5",
                  ownCode: "pv2-alt",
                  ownDetailCode: "cv2-alt",
                  title: "Contraption",
                },
                { entryId: "e6", ownCode: "pv2-alt2", ownDetailCode: "cv2-alt3", title: "Gizmo" },
              ],
            },
          ],
        },
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function entryDetailsCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/entries/details?code=pv1&detail=cv1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      details: [
        { entryId: "e1", description: "A widget." },
        { entryId: "e2", description: "A gadget." },
        { entryId: "e3", description: "A doohickey." },
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
    url: `${BASE}/catalog/entries/details?code=zzz-unrelated&detail=zzz-unrelated-detail`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { details: [{ entryId: "zzz-unrelated", description: "An unrelated entry." }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const ENTRY_DETAILS_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/entries/details",
  resultsPath: "data.catalog.sections.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
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

function emitContract(): { contract: string; primaryResponseBody: unknown } {
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

  const contract = emitContractTs({
    siteId: "dual-item-literal-ancestor-scoped-contract-test",
    pascal: "DualItemLiteralAncestorScopedContractTest",
    baseUrl: BASE,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: true,
    gqlQuery: SEARCH_QUERY,
    endpointPath: "/graphql",
    gqlOperationName: "catalogSearch",
    gqlVariables: {},
    auxFiles: [],
    actionSteps,
    foldReturnSpec: ENTRY_DETAILS_SPEC,
  });

  return { contract, primaryResponseBody };
}

describe("emitContractTs — dual item-literal drill params, each on a distinct nested ancestor sub-path, both hoist", () => {
  it("emits the drill fetch call site bound to both nested ancestor fields only, between the group and item loop opens, deduped to one call site", () => {
    const { contract } = emitContract();

    expect(contract).toContain("getGql(context.baseUrl)(");
    // #330/#339 dedup guard: exactly one drill `await httpClient(` call site
    // is ever emitted, regardless of how many items share the group.
    expect((contract.match(/await httpClient\(/g) ?? []).length).toBe(1);

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    const groupLoopIndex = executeHttpBody.indexOf("for (const g0 of");
    const drillFetchCallIndex = executeHttpBody.indexOf("catalog/entries/details?code=");
    const itemLoopIndex = executeHttpBody.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillFetchCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillFetchCallIndex).toBeLessThan(itemLoopIndex);
    expect(executeHttpBody).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      "catalog/entries/details?code=${g0.primaryVariant.code}&detail=${g0.cheapestVariant.detail.code}"
    );
    expect(executeHttpBody).not.toContain("${item");
  });

  it("at runtime, calls the drill endpoint exactly once per group and joins every sibling item correctly, including ones whose own two fields diverge", async () => {
    const { contract, primaryResponseBody } = emitContract();
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    // Only the two group-scoped drill fetches go through `fetch` — the
    // GraphQL primary is served by `getGql`.
    stubSequentialFetch([
      {
        details: [
          { entryId: "e1", description: "A widget." },
          { entryId: "e2", description: "A gadget." },
          { entryId: "e3", description: "A doohickey." },
        ],
      },
      {
        details: [
          { entryId: "e4", description: "A thingamajig." },
          { entryId: "e5", description: "A contraption." },
          { entryId: "e6", description: "A gizmo." },
        ],
      },
    ]);

    const gqlCalls: { operationName: string; query: string; variables: unknown }[] = [];
    const getGql =
      (_baseUrl: string) =>
      async (operationName: string, query: string, variables: Record<string, unknown>) => {
        gqlCalls.push({ operationName, query, variables });
        return primaryResponseBody;
      };

    const executeHttp = evalSinglePrimaryExecuteHttp(
      executeHttpBody,
      getGql,
      httpClient,
      "DUALITEMLITERALANCESTORSCOPEDCONTRACTTEST_QUERY",
      SEARCH_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);

    expect(result.data).toEqual({
      data: {
        catalog: {
          sections: [
            {
              masterCode: "grp1",
              primaryVariant: { code: "pv1" },
              cheapestVariant: { detail: { code: "cv1" } },
              entries: [
                {
                  entryId: "e1",
                  ownCode: "pv1",
                  ownDetailCode: "cv1",
                  title: "Widget",
                  description: "A widget.",
                },
                {
                  entryId: "e2",
                  ownCode: "pv1-alt",
                  ownDetailCode: "cv1-alt",
                  title: "Gadget",
                  description: "A gadget.",
                },
                {
                  entryId: "e3",
                  ownCode: "pv1-alt2",
                  ownDetailCode: "cv1-alt3",
                  title: "Doohickey",
                  description: "A doohickey.",
                },
              ],
            },
            {
              masterCode: "grp2",
              primaryVariant: { code: "pv2" },
              cheapestVariant: { detail: { code: "cv2" } },
              entries: [
                {
                  entryId: "e4",
                  ownCode: "pv2",
                  ownDetailCode: "cv2",
                  title: "Thingamajig",
                  description: "A thingamajig.",
                },
                {
                  entryId: "e5",
                  ownCode: "pv2-alt",
                  ownDetailCode: "cv2-alt",
                  title: "Contraption",
                  description: "A contraption.",
                },
                {
                  entryId: "e6",
                  ownCode: "pv2-alt2",
                  ownDetailCode: "cv2-alt3",
                  title: "Gizmo",
                  description: "A gizmo.",
                },
              ],
            },
          ],
        },
      },
    });

    // Exactly 2 fetches — one drill per group, not one per item (which would
    // make 6 across a 2-group/3-item fixture) and not only for the
    // literal-matching item.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0]![0])).toContain("code=pv1");
    expect(String(calls[0]![0])).toContain("detail=cv1");
    expect(String(calls[1]![0])).toContain("code=pv2");
    expect(String(calls[1]![0])).toContain("detail=cv2");
  });
});
