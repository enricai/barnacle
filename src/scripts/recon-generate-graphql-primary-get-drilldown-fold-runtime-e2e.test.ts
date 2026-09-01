import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const NESTED_SEARCH_QUERY =
  "query companySearch { companySearch { companies { id postings { id title } } } }";

function nestedGraphqlSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: NESTED_SEARCH_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      jobSearch: {
        companies: [
          {
            id: "company-1",
            postings: [
              { id: "job-1", title: "Engineer" },
              { id: "job-2", title: "Designer" },
            ],
          },
          {
            id: "company-2",
            postings: [{ id: "job-3", title: "Analyst" }],
          },
        ],
      },
    },
    operationName: "companySearch",
    query: NESTED_SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

const NESTED_JOB_OPENINGS_SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/openings",
  resultsPath: "jobSearch.companies.*.postings",
  drillResultsPath: "opening",
  joinFields: ["id"],
};

const NESTED_OPENING_LOCATIONS_BY_JOB_ID: Record<
  string,
  { opening: { id: string; location: string }[] }
> = {
  "job-1": { opening: [{ id: "job-1", location: "Remote" }] },
  "job-2": { opening: [{ id: "job-2", location: "Onsite" }] },
  "job-3": { opening: [{ id: "job-3", location: "Hybrid" }] },
};

function stubNestedJobOpeningsFetch(): void {
  const fn = vi.fn(async (url: string) => {
    const jobId = new URL(url).searchParams.get("id") ?? "";
    const response = NESTED_OPENING_LOCATIONS_BY_JOB_ID[jobId];
    if (!response) {
      throw new Error(`stubNestedJobOpeningsFetch: no opening fixture for job id "${jobId}"`);
    }
    return jsonResponse(response);
  });
  vi.stubGlobal("fetch", fn);
}

const NONJOIN_SEARCH_QUERY =
  "query companySearch { companySearch { companies { id packageCode title } } }";

function nonJoinRequestGraphqlSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: NONJOIN_SEARCH_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      companySearch: {
        companies: [
          { id: "job-1", packageCode: "PKG-1", title: "Engineer" },
          { id: "job-2", packageCode: "PKG-2", title: "Designer" },
        ],
      },
    },
    operationName: "companySearch",
    query: NONJOIN_SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

/**
 * Unlike {@link restDrillDownCapture}, this drill request is keyed by
 * `packageCode` (`?code=PKG-1`) — the join field the flow declares (`id`)
 * never appears in the request at all, only in the response, which echoes
 * it back on the SAME per-item field name the primary uses.
 */
function nonJoinRequestDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/openings?code=PKG-1`,
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

/**
 * Unlike {@link nonJoinRequestDrillDownCapture}, this drill request carries
 * NO per-item field at all (a static, unparameterized URL), and its
 * response never echoes `id` either — genuinely unresolvable by either the
 * structural heuristic (nothing threads into the request) or a declared
 * `foldReturn` naming `id` (nothing to match in the response).
 */
function unthreadedDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/listings/api/v1/openings`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { opening: [{ location: "Nowhere" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const NONJOIN_JOB_OPENINGS_SPEC: FoldReturnSpec = {
  endpointPattern: "/listings/api/v1/openings",
  resultsPath: "companySearch.companies",
  drillResultsPath: "opening",
  joinFields: ["id"],
};

/** Every drill response returns TWO items — the real match plus a decoy
 * sharing the requested `packageCode` — so a merge that fell back to "first
 * item in the response" instead of actually matching on `id` would silently
 * fold the wrong (decoy) item onto every primary item past the first. */
const NONJOIN_OPENING_LOCATIONS_BY_PACKAGE_CODE: Record<
  string,
  { opening: { id: string; location: string }[] }
> = {
  "PKG-1": {
    opening: [
      { id: "job-1", location: "Remote" },
      { id: "decoy-1", location: "WRONG" },
    ],
  },
  "PKG-2": {
    opening: [
      { id: "decoy-2", location: "WRONG" },
      { id: "job-2", location: "Onsite" },
    ],
  },
};

function stubNonJoinJobOpeningsFetch(): void {
  const fn = vi.fn(async (url: string) => {
    const packageCode = new URL(url).searchParams.get("code") ?? "";
    const response = NONJOIN_OPENING_LOCATIONS_BY_PACKAGE_CODE[packageCode];
    if (!response) {
      throw new Error(
        `stubNonJoinJobOpeningsFetch: no opening fixture for package code "${packageCode}"`
      );
    }
    return jsonResponse(response);
  });
  vi.stubGlobal("fetch", fn);
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

  it("folds the drill-down onto a nested-array primary (resultsPath with a wildcard group) via a .flatMap accessor, across multiple outer groups", async () => {
    const captures = [nestedGraphqlSearchCapture(), restDrillDownCapture()] as never[];

    const actionCaptures = extractGraphQLActionSequence(captures, null, NESTED_JOB_OPENINGS_SPEC);
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

    const foldPlans = resolveFoldPlan(actionSteps, NESTED_JOB_OPENINGS_SPEC);
    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.targets.length).toBeGreaterThan(0);

    const primaryResponseBody = actionSteps[0]!.capture.responseBody;

    const contract = emitContractTs({
      siteId: "job-openings-nested-fold-test",
      pascal: "JobOpeningsNestedFoldTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: primaryResponseBody,
      gql: true,
      gqlQuery: NESTED_SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "companySearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps,
      foldReturnSpec: NESTED_JOB_OPENINGS_SPEC,
    });

    expect(contract).toContain("getGql(context.baseUrl)(");

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);
    // The nested resultsPath's wildcard group must generalize across every
    // outer group via a nested loop — a literal index into one group (e.g.
    // `.companies[0].postings`) would silently drop every other group's
    // items at runtime.
    expect(executeHttpBody).toContain("for (const g0 of");
    expect(executeHttpBody).not.toMatch(/\.companies\[\d+\]/);
    expect(executeHttpBody).toContain("for (const item of g0.postings)");

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubNestedJobOpeningsFetch();

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
      "JOBOPENINGSNESTEDFOLDTEST_QUERY",
      NESTED_SEARCH_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);
    expect(gqlCalls[0]!.operationName).toBe("companySearch");

    expect(result.data).toEqual({
      jobSearch: {
        companies: [
          {
            id: "company-1",
            postings: [
              { id: "job-1", title: "Engineer", location: "Remote" },
              { id: "job-2", title: "Designer", location: "Onsite" },
            ],
          },
          {
            id: "company-2",
            postings: [{ id: "job-3", title: "Analyst", location: "Hybrid" }],
          },
        ],
      },
    });
    // One drill-down call per postings item, flattened across both outer
    // company groups.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("resolves and correctly matches a foldReturn whose declared joinFields name a field absent from the drill request but present on its response", async () => {
    const withCaptures = [
      nonJoinRequestGraphqlSearchCapture(),
      nonJoinRequestDrillDownCapture(),
    ] as never[];

    const withActionCaptures = extractGraphQLActionSequence(
      withCaptures,
      null,
      NONJOIN_JOB_OPENINGS_SPEC
    );
    const withStateIndex = indexStateValues(
      withCaptures,
      new Set(),
      new Set(withActionCaptures.map((a) => a.index))
    );
    const withActionSteps = compileActionSteps(withActionCaptures, withStateIndex);
    const withPrimaryResponseBody = withActionSteps[0]!.capture.responseBody;

    const contractWith = emitContractTs({
      siteId: "nonjoin-fold-test",
      pascal: "NonjoinFoldTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: withPrimaryResponseBody,
      gql: true,
      gqlQuery: NONJOIN_SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "companySearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps: withActionSteps,
      foldReturnSpec: NONJOIN_JOB_OPENINGS_SPEC,
    });

    // Same extracted actionSteps as the WITH case, but with the declared
    // foldReturn withheld from emission — isolates what the SPEC's own
    // `joinFields` contribute over the structural heuristic alone (which,
    // independent of any foldReturn, still detects `packageCode` threading
    // into the drill request on its own). The structural-only merge matches
    // on `packageCode` — a field the drill response never carries — while
    // the spec-driven merge correctly matches on the declared `id`.
    const contractWithout = emitContractTs({
      siteId: "nonjoin-fold-test",
      pascal: "NonjoinFoldTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: withPrimaryResponseBody,
      gql: true,
      gqlQuery: NONJOIN_SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "companySearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps: withActionSteps,
      foldReturnSpec: null,
    });

    expect(contractWith).not.toEqual(contractWithout);
    expect(contractWith).toContain("/listings/api/v1/openings");
    expect(contractWithout).toContain("/listings/api/v1/openings");
    expect(contractWith).toContain('m["id"]');
    expect(contractWithout).not.toContain('m["id"]');
    expect(contractWithout).toContain('m["packageCode"]');

    const executeHttpBodyWith = extractExecuteHttpBodyFromContract(contractWith);
    expect(executeHttpBodyWith).toContain("for (const item of foldItems)");
    // The URL must be parameterized off `packageCode` — the field the
    // captured request actually varies on — even though the declared
    // joinFields name `id`, a field the request never carries.
    expect(executeHttpBodyWith).toContain("item.packageCode");

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubNonJoinJobOpeningsFetch();

    const getGql = () => async () => withPrimaryResponseBody;
    const executeHttp = evalSinglePrimaryExecuteHttp(
      executeHttpBodyWith,
      getGql,
      httpClient,
      "NONJOINFOLDTEST_QUERY",
      NONJOIN_SEARCH_QUERY
    );
    const result = await executeHttp({}, { baseUrl: BASE });

    // The drill response for each package code returns TWO items (the real
    // match plus a decoy); the merge must pick the one whose `id` actually
    // matches the primary item's own `id`, not just the first response item.
    expect(result.data).toEqual({
      companySearch: {
        companies: [
          { id: "job-1", packageCode: "PKG-1", title: "Engineer", location: "Remote" },
          { id: "job-2", packageCode: "PKG-2", title: "Designer", location: "Onsite" },
        ],
      },
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("emits the 'no fold plan resolved' warning when a declared foldReturn's joinFields name a field absent from BOTH the drill request and its response", () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-gql-nonjoin-unresolvable-"));
    const runRoot = join(workDir, "run");
    const REPO_ROOT = join(__dirname, "..", "..");
    const siteId = `gql-nonjoin-unresolvable-run${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    try {
      mkdirSync(join(runRoot, "graphql"), { recursive: true });
      mkdirSync(join(runRoot, "replays"), { recursive: true });
      mkdirSync(join(runRoot, "aux"), { recursive: true });
      writeFileSync(
        join(runRoot, "graphql", "000-browse-search.json"),
        JSON.stringify(nonJoinRequestGraphqlSearchCapture())
      );
      writeFileSync(
        join(runRoot, "graphql", "001-browse-drill.json"),
        JSON.stringify(unthreadedDrillDownCapture())
      );
      mkdirSync(siteOutDir, { recursive: true });
      writeFileSync(
        join(siteOutDir, "recon-flow.json"),
        JSON.stringify({
          steps: [{ step: "search for companies" }],
          foldReturn: {
            endpointPattern: NONJOIN_JOB_OPENINGS_SPEC.endpointPattern,
            resultsPath: NONJOIN_JOB_OPENINGS_SPEC.resultsPath,
            drillResultsPath: NONJOIN_JOB_OPENINGS_SPEC.drillResultsPath,
            joinFields: NONJOIN_JOB_OPENINGS_SPEC.joinFields,
          },
        })
      );

      const result = spawnSync(
        join(REPO_ROOT, "node_modules", ".bin", "tsx"),
        [
          join(REPO_ROOT, "src", "scripts", "recon-generate.ts"),
          "--site-id",
          siteId,
          "--run-dir",
          runRoot,
          "--emit",
          "ts",
          "--force",
        ],
        { cwd: REPO_ROOT, encoding: "utf8" }
      );
      const out = `${result.stdout}\n${result.stderr}`;

      expect(result.status, out).toBe(0);
      expect(out).toContain("no fold plan resolved");

      const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
      expect(contract).not.toContain("/listings/api/v1/openings");
      expect(contract).not.toContain("foldItems");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(siteOutDir, { recursive: true, force: true });
    }
  }, 30_000);
});
