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
 * Closes the sibling-site coverage gap: the scope-coincidence rebind
 * (a drill's captured literal equals only the matched item's own field,
 * while its response is proven ancestor-scoped) was only exercised through
 * `emitMultiStepExecuteHttp` (see
 * recon-generate-drilldown-fold-scope-coincident-ancestor-hoist-runtime-e2e.test.ts),
 * never `emitContractTs` - the generated-plugin `contract.ts` path used for
 * every non-submission (search/read) flow, including the one the original
 * report's own samples were drawn from.
 */

const GROUPS_QUERY =
  "query groupsSearch { search { groups { representative { code } entries { entryId code } } } }";

// `representative.code` is the ancestor's structurally-corresponding field
// (same trailing "code" segment as the item's own field) but its VALUE
// deliberately differs from the drill literal ("grp-1-rep"/"grp-2-rep" vs
// the captured "sec1") — so a plain value-equality search of the ancestor
// scope can never find it, and only the matched item's own `code` ("sec1")
// literally equals what was captured. That is the exact ambiguity
// isFoldTargetAncestorScoped + findStructurallyCorrespondingAncestorField
// exist to resolve: the drill's own response still proves it is
// ancestor-scoped (it resolves onto every sibling entry, not just e1), so
// the emitted request must thread off `representative.code`, not `item.code`.
function groupsGraphqlSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: GROUPS_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      data: {
        search: {
          groups: [
            {
              representative: { code: "grp-1-rep" },
              entries: [
                { entryId: "e1", code: "sec1", name: "Widget" },
                { entryId: "e2", code: "e2-code", name: "Gadget" },
                { entryId: "e3", code: "e3-code", name: "Doohickey" },
              ],
            },
            {
              representative: { code: "grp-2-rep" },
              entries: [
                { entryId: "e4", code: "sec2", name: "Thingamajig" },
                { entryId: "e5", code: "e5-code", name: "Contraption" },
                { entryId: "e6", code: "e6-code", name: "Gizmo" },
              ],
            },
          ],
        },
      },
    },
    operationName: "groupsSearch",
    query: GROUPS_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function scopeCoincidentDrillCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/entries/details?code=sec1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      details: [
        { entryId: "e1", description: "A widget." },
        { entryId: "e2", description: "A gadget." },
        { entryId: "e3", description: "A doohichey." },
      ],
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const SCOPE_COINCIDENT_SPEC: FoldReturnSpec = {
  endpointPattern: "catalog/entries/details",
  resultsPath: "data.search.groups.*.entries",
  drillResultsPath: "details",
  joinFields: ["entryId"],
};

const DETAILS_BY_CODE: Record<string, { details: { entryId: string; description: string }[] }> = {
  "grp-1-rep": {
    details: [
      { entryId: "e1", description: "A widget." },
      { entryId: "e2", description: "A gadget." },
      { entryId: "e3", description: "A doohickey." },
    ],
  },
  "grp-2-rep": {
    details: [
      { entryId: "e4", description: "A thingamajig." },
      { entryId: "e5", description: "A contraption." },
      { entryId: "e6", description: "A gizmo." },
    ],
  },
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

function stubDetailsFetch(): void {
  const fn = vi.fn(async (url: string) => {
    const code = new URL(url).searchParams.get("code") ?? "";
    const response = DETAILS_BY_CODE[code];
    if (!response) {
      throw new Error(`stubDetailsFetch: no details fixture for code "${code}"`);
    }
    return jsonResponse(response);
  });
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

describe("emitContractTs — scope-coincident drill still hoists to the ancestor binding", () => {
  it("structurally hoists the drill call above the item loop, bound to the ancestor field only, never an item field", async () => {
    const captures = [groupsGraphqlSearchCapture(), scopeCoincidentDrillCapture()] as never[];

    const actionCaptures = extractGraphQLActionSequence(captures, null, SCOPE_COINCIDENT_SPEC);
    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    const foldPlans = resolveFoldPlan(actionSteps, SCOPE_COINCIDENT_SPEC);
    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);

    const primaryResponseBody = actionSteps[0]!.capture.responseBody;

    const contract = emitContractTs({
      siteId: "scope-coincident-drill-hoist-test",
      pascal: "ScopeCoincidentDrillHoistTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: primaryResponseBody,
      gql: true,
      gqlQuery: GROUPS_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "groupsSearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps,
      foldReturnSpec: SCOPE_COINCIDENT_SPEC,
    });

    expect((contract.match(/await httpClient\(/g) ?? []).length).toBe(1);

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const groupLoopIndex = executeHttpBody.indexOf("for (const g0 of");
    const drillCallIndex = executeHttpBody.indexOf("await httpClient(");
    const itemLoopIndex = executeHttpBody.indexOf("for (const item of");

    expect(groupLoopIndex).toBeGreaterThanOrEqual(0);
    expect(drillCallIndex).toBeGreaterThanOrEqual(0);
    expect(itemLoopIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillCallIndex).toBeGreaterThan(groupLoopIndex);
    expect(drillCallIndex).toBeLessThan(itemLoopIndex);

    const drillUrlLineMatch = executeHttpBody
      .slice(drillCallIndex, itemLoopIndex)
      .match(/`[^`]*code=\$\{[^}]+\}[^`]*`/);
    expect(drillUrlLineMatch).not.toBeNull();
    const drillUrlTemplate = drillUrlLineMatch![0];
    expect(drillUrlTemplate).toMatch(/\$\{g0\./);
    expect(drillUrlTemplate).not.toContain("${item.");

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDetailsFetch();

    const getGql = (_baseUrl: string) => async (_operationName: string, _query: string) =>
      primaryResponseBody;

    const executeHttp = evalSinglePrimaryExecuteHttp(
      executeHttpBody,
      getGql,
      httpClient,
      "SCOPECOINCIDENTDRILLHOISTTEST_QUERY",
      GROUPS_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(result.data).toEqual({
      data: {
        search: {
          groups: [
            {
              representative: { code: "grp-1-rep" },
              entries: [
                { entryId: "e1", code: "sec1", name: "Widget", description: "A widget." },
                { entryId: "e2", code: "e2-code", name: "Gadget", description: "A gadget." },
                { entryId: "e3", code: "e3-code", name: "Doohickey", description: "A doohickey." },
              ],
            },
            {
              representative: { code: "grp-2-rep" },
              entries: [
                { entryId: "e4", code: "sec2", name: "Thingamajig", description: "A thingamajig." },
                {
                  entryId: "e5",
                  code: "e5-code",
                  name: "Contraption",
                  description: "A contraption.",
                },
                { entryId: "e6", code: "e6-code", name: "Gizmo", description: "A gizmo." },
              ],
            },
          ],
        },
      },
    });

    // Exactly one drill fetch per group, not per item, and not restricted to
    // only the item whose own field happened to coincide with the literal.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(fetch).mock.calls;
    expect(String(calls[0]![0])).toContain("code=grp-1-rep");
    expect(String(calls[1]![0])).toContain("code=grp-2-rep");
  });
});
