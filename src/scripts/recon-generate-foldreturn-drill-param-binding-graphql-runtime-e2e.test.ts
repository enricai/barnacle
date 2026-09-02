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

const SEARCH_QUERY = "query jobSearch { jobSearch { postings { id title } } }";

function graphqlSearchCapture(): unknown {
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
      jobSearch: {
        postings: [
          { id: "job-1", title: "Engineer" },
          { id: "job-2", title: "Designer" },
        ],
      },
    },
    operationName: "jobSearch",
    query: SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

/** Every drill request also carries a `radius` query param frozen to the
 * captured value — the same shape `drillParamBindings` exists to unfreeze
 * (see recon-generate-foldreturn-cannot-bind-drill-query-param-to-caller-payload.md). */
function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/openings?id=job-1&radius=10`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { opening: [{ id: "job-1", location: "Remote" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const JOB_OPENINGS_SPEC_WITH_BINDING: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/openings",
  resultsPath: "jobSearch.postings",
  drillResultsPath: "opening",
  joinFields: ["id"],
  drillParamBindings: {
    radius: { payloadField: "radius", type: "int", default: 10 },
  },
};

const JOB_OPENINGS_SPEC_WITHOUT_BINDING: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/openings",
  resultsPath: "jobSearch.postings",
  drillResultsPath: "opening",
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

const OPENING_LOCATIONS_BY_JOB_ID: Record<string, { opening: { id: string; location: string }[] }> =
  {
    "job-1": { opening: [{ id: "job-1", location: "Remote" }] },
    "job-2": { opening: [{ id: "job-2", location: "Onsite" }] },
  };

function stubJobOpeningsFetch(): void {
  const fn = vi.fn(async (url: string) => {
    const jobId = new URL(url).searchParams.get("id") ?? "";
    const response = OPENING_LOCATIONS_BY_JOB_ID[jobId];
    if (!response) {
      throw new Error(`stubJobOpeningsFetch: no opening fixture for job id "${jobId}"`);
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

function buildContract(
  spec: FoldReturnSpec,
  pascal: string
): {
  contract: string;
  executeHttpBody: string;
  primaryResponseBody: unknown;
} {
  const captures = [graphqlSearchCapture(), restDrillDownCapture()] as never[];
  const actionCaptures = extractGraphQLActionSequence(captures, null, spec);
  const stateIndex = indexStateValues(
    captures,
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);
  const foldPlans = resolveFoldPlan(actionSteps, spec);
  expect(foldPlans.length).toBeGreaterThan(0);
  const primaryResponseBody = actionSteps[0]!.capture.responseBody;

  const contract = emitContractTs({
    siteId: `${pascal.toLowerCase()}-test`,
    pascal,
    baseUrl: BASE,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: true,
    gqlQuery: SEARCH_QUERY,
    endpointPath: "/graphql",
    gqlOperationName: "jobSearch",
    gqlVariables: {},
    auxFiles: [],
    actionSteps,
    foldReturnSpec: spec,
  });

  return {
    contract,
    executeHttpBody: extractExecuteHttpBodyFromContract(contract),
    primaryResponseBody,
  };
}

describe("declared drillParamBindings on the GraphQL single-primary fold path — emission and runtime e2e", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder in the test description, not a template
  it("emits the bound `${payload.<field> ?? <default>}` accessor into the drill URL instead of freezing the captured literal", () => {
    const { executeHttpBody } = buildContract(
      JOB_OPENINGS_SPEC_WITH_BINDING,
      "JobOpeningsBoundFoldTest"
    );

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(executeHttpBody).toContain("${payload.radius ?? 10}");
    expect(executeHttpBody).not.toContain("radius=10");
  });

  it("keeps emitting the frozen literal unchanged for a sibling flow with no declared drillParamBindings", () => {
    const { executeHttpBody } = buildContract(
      JOB_OPENINGS_SPEC_WITHOUT_BINDING,
      "JobOpeningsUnboundFoldTest"
    );

    expect(executeHttpBody).toContain("radius=10");
    expect(executeHttpBody).not.toContain("${payload.radius");
  });

  it("runs the bound URL against the mocked drill fetch at runtime, substituting the caller's payload value", async () => {
    const { executeHttpBody, primaryResponseBody } = buildContract(
      JOB_OPENINGS_SPEC_WITH_BINDING,
      "JobOpeningsBoundRuntimeTest"
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    let lastRequestedRadius: string | null = null;
    const fn = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      lastRequestedRadius = parsed.searchParams.get("radius");
      const jobId = parsed.searchParams.get("id") ?? "";
      const response = OPENING_LOCATIONS_BY_JOB_ID[jobId];
      if (!response) {
        throw new Error(`no opening fixture for job id "${jobId}"`);
      }
      return jsonResponse(response);
    });
    vi.stubGlobal("fetch", fn);

    const getGql = () => async () => primaryResponseBody;
    const executeHttp = evalSinglePrimaryExecuteHttp(
      executeHttpBody,
      getGql,
      httpClient,
      "JOBOPENINGSBOUNDRUNTIMETEST_QUERY",
      SEARCH_QUERY
    );

    const result = await executeHttp({ radius: 25 }, { baseUrl: BASE });

    expect(lastRequestedRadius).toBe("25");
    expect(result.data).toEqual({
      jobSearch: {
        postings: [
          { id: "job-1", title: "Engineer", location: "Remote" },
          { id: "job-2", title: "Designer", location: "Onsite" },
        ],
      },
    });
  });

  it("falls back to the declared default when the caller omits the bound payload field", async () => {
    const { executeHttpBody, primaryResponseBody } = buildContract(
      JOB_OPENINGS_SPEC_WITH_BINDING,
      "JobOpeningsDefaultRuntimeTest"
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubJobOpeningsFetch();

    const getGql = () => async () => primaryResponseBody;
    const executeHttp = evalSinglePrimaryExecuteHttp(
      executeHttpBody,
      getGql,
      httpClient,
      "JOBOPENINGSDEFAULTRUNTIMETEST_QUERY",
      SEARCH_QUERY
    );

    const result = await executeHttp({}, { baseUrl: BASE });

    expect(result.data).toEqual({
      jobSearch: {
        postings: [
          { id: "job-1", title: "Engineer", location: "Remote" },
          { id: "job-2", title: "Designer", location: "Onsite" },
        ],
      },
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
