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
 * Reproduces the reported failure across the FULL extraction-through-runtime
 * chain (`extractGraphQLActionSequence` -> `compileActionSteps` ->
 * `resolveFoldPlan` -> `emitContractTs` -> evaluated `executeHttp`), not just
 * the downstream fold-and-emit stage every other `*-fold-*-runtime-e2e` file
 * exercises starting from an already-built `ActionStep[]`. Before the
 * bugfix-001/002 fixes, this exact scenario (a GraphQL `query`-kind primary
 * with a declared `foldReturn`) was misclassified as a submission flow and
 * regressed the entire generated contract to the raw-replay/ATS shape (see
 * docs/recon-generate-foldreturn-regresses-primary-op-and-payload-to-ats-submission-shape.md).
 * The fixed behavior routes this scenario through `emitContractTs`'s
 * single-primary `getGql`/`httpClient` fold-merge hot path instead of
 * `emitMultiStepExecuteHttp` — this test pins that contract, not the
 * multi-step emitter, as the observable output.
 */

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

function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/openings?id=job-1`,
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

const JOB_OPENINGS_SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/openings",
  resultsPath: "jobSearch.postings",
  drillResultsPath: "opening",
  joinFields: ["id"],
};

const OPENING_LOCATIONS_BY_JOB_ID: Record<string, { opening: { id: string; location: string }[] }> =
  {
    "job-1": { opening: [{ id: "job-1", location: "Remote" }] },
    "job-2": { opening: [{ id: "job-2", location: "Onsite" }] },
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

/**
 * Evaluates the single-primary hot path's `executeHttp` body — unlike
 * `evalExecuteHttpBody` (which only injects `httpClient` for the multi-step
 * emitter), this path calls `getGql(context.baseUrl)(...)` for the primary
 * operation and `httpClient(...)` only for the folded drill-down call, so
 * both bindings plus a `context` argument are required.
 */
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

describe("GraphQL-primary + captured GET REST drill-down foldReturn — extraction through runtime e2e", () => {
  it("falsifier: without a declared foldReturn, extraction drops BOTH the GraphQL query primary and the GET drill-down", () => {
    const captures = [graphqlSearchCapture(), restDrillDownCapture()] as never[];

    const actionCaptures = extractGraphQLActionSequence(captures);

    expect(actionCaptures).toHaveLength(0);
  });

  it("resolves a fold plan and folds the drill-down's per-item field onto the single-primary getGql/httpClient emission at runtime", async () => {
    const captures = [graphqlSearchCapture(), restDrillDownCapture()] as never[];

    const actionCaptures = extractGraphQLActionSequence(captures, null, JOB_OPENINGS_SPEC);
    expect(actionCaptures.map((a) => (a.capture as { method: string }).method)).toEqual([
      "POST",
      "GET",
    ]);

    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    expect(actionSteps).toHaveLength(2);

    const foldPlans = resolveFoldPlan(actionSteps, JOB_OPENINGS_SPEC);
    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);

    const primaryResponseBody = actionSteps[0]!.capture.responseBody;

    const contract = emitContractTs({
      siteId: "job-openings-fold-test",
      pascal: "JobOpeningsFoldTest",
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
      foldReturnSpec: JOB_OPENINGS_SPEC,
    });

    // The doc's own marker table (see docblock above): a clean single-primary
    // `getGql(` call must be present, and every raw-replay/ATS marker the
    // regression introduced must be absent.
    expect(contract).toContain("getGql(context.baseUrl)(");
    expect(contract).not.toContain("ApplicantContactSchema");
    expect(contract).not.toContain("multipartJsonObject");
    expect(contract).not.toContain("BaseUrl: z.string()");
    expect(contract).not.toContain("payload.operationName");
    expect(contract).not.toContain("payload.variables");
    expect(contract).not.toContain("payload.BaseUrl");

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    expect(executeHttpBody).toContain("for (const item of foldItems)");

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubJobOpeningsFetch();

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
      "JOBOPENINGSFOLDTEST_QUERY",
      SEARCH_QUERY
    );
    // Caller-friendly payload: no BaseUrl/operationName/variables in the call
    // signature — the pre-fix raw-replay shape required all three.
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);
    expect(gqlCalls[0]!.operationName).toBe("jobSearch");

    expect(result.data).toEqual({
      jobSearch: {
        postings: [
          { id: "job-1", title: "Engineer", location: "Remote" },
          { id: "job-2", title: "Designer", location: "Onsite" },
        ],
      },
    });
    // One drill-down call per primary item — the primary GraphQL call itself
    // goes through the mocked `getGql`, not `fetch`.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
