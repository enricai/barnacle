import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
  resolveFoldPlan,
} from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";

const BASE = "https://api.example.com";

/**
 * Reproduces the reported failure across the FULL extraction-through-runtime
 * chain (`extractGraphQLActionSequence` -> `compileActionSteps` ->
 * `resolveFoldPlan` -> `emitMultiStepExecuteHttp` -> evaluated `executeHttp`),
 * not just the downstream fold-and-emit stage every other
 * `*-fold-*-runtime-e2e` file exercises starting from an already-built
 * `ActionStep[]`. Before the fix, `extractGraphQLActionSequence` admitted the
 * captured GET drill-down (it matches `foldReturn.endpointPattern`) but
 * dropped the GraphQL `query` primary itself — neither a `mutation` nor an
 * `endpointPattern` match — so `resolveFoldPlan` was handed an action
 * sequence with no primary capture to resolve `resultsPath` against and
 * produced an empty plan, however correct the declared `foldReturn` was.
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
    if (!url.includes("/listings/api/v1/openings")) {
      return jsonResponse({
        jobSearch: {
          postings: [
            { id: "job-1", title: "Engineer" },
            { id: "job-2", title: "Designer" },
          ],
        },
      });
    }
    const jobId = new URL(url).searchParams.get("id") ?? "";
    const response = OPENING_LOCATIONS_BY_JOB_ID[jobId];
    if (!response) {
      throw new Error(`stubJobOpeningsFetch: no opening fixture for job id "${jobId}"`);
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

  it("resolves a fold plan and folds the drill-down's per-item field onto every primary item at runtime", async () => {
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

    const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;
    const body = emitMultiStepExecuteHttp(
      actionSteps,
      inputBody,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      BASE,
      new Map(),
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      JOB_OPENINGS_SPEC
    );

    expect(body).toContain("for (const item of foldItems)");

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubJobOpeningsFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: BASE, query: SEARCH_QUERY, variables: {} });

    expect(result.data).toEqual({
      jobSearch: {
        postings: [
          { id: "job-1", title: "Engineer", location: "Remote" },
          { id: "job-2", title: "Designer", location: "Onsite" },
        ],
      },
    });
    // One primary GraphQL call plus one drill-down call per primary item.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
