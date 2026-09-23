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
} from "@/scripts/recon-generate";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";

const BASE = "https://api.example.com";

const CATALOG_QUERY =
  "query catalogSearch { catalogSearch { postings { id catalogNumber edition { publisher format } title } } }";

/**
 * Reproduces Finding 2 of the recon-generate-1.12.64 report through the
 * exact call site it names — `emitContractTs`'s single-primary
 * `getGql`/`httpClient` fold-merge loop (`multiStepBody` unset, `gql`
 * primary; see `recon-generate-graphql-primary-get-drilldown-fold-runtime-
 * e2e.test.ts`'s docblock, which labels this the same hot path). Two
 * postings each drill down to their OWN endpoint identity
 * (`/library/api/v1/editions/1`, `/library/api/v1/editions/2`), and both
 * requests thread the SAME nested `edition.publisher`/`edition.format`
 * pair (colliding structural values), so the structural heuristic guesses
 * THAT pair as its own `joinFields` for BOTH targets — the exact
 * multi-target scenario `resolveFoldPlan`/`mergeSpecPlanOntoSamePrimary`
 * only partially overrode pre-fix (see
 * `recon-generate-foldreturn-declared-joinfields-response-only-single-
 * primary-override-runtime-e2e.test.ts`, which pins that same multi-target
 * disagreement with flat, non-nested fields). This test compounds it
 * further: EACH drill target's own response additionally returns TWO
 * candidate items sharing the identical colliding `publisher`/`format`
 * pair but distinct `catalogNumber` values, so even a merge that correctly
 * overrode every target's joinFields but fell back to "first response
 * item" within a target would still silently fold the wrong candidate.
 * Only matching on the declared `foldReturn.joinFields: ["catalogNumber"]`
 * — a field that never threads into any drill request, only each drill's
 * own response — resolves both dimensions correctly.
 */
function catalogSearchCapture(): unknown {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: CATALOG_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      catalogSearch: {
        postings: [
          {
            id: "post-1",
            catalogNumber: "CAT-1",
            edition: { publisher: "Acme", format: "Hardcover" },
            title: "Book A",
          },
          {
            id: "post-2",
            catalogNumber: "CAT-2",
            edition: { publisher: "Acme", format: "Hardcover" },
            title: "Book B",
          },
        ],
      },
    },
    operationName: "catalogSearch",
    query: CATALOG_QUERY,
    variables: {},
    decodedParams: null,
  };
}

/**
 * Each posting drills to its OWN endpoint identity (`/editions/1`,
 * `/editions/2`), but both requests thread the identical nested
 * `edition.publisher`/`edition.format` pair — the structural coincidence.
 * Each response returns TWO candidate items ("real" plus a "decoy") that
 * ALSO share that identical pair, distinguishable only by `catalogNumber`.
 */
function editionsDrillCapture(index: number, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `${BASE}/library/api/v1/editions/${index}?publisher=Acme&format=Hardcover`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      edition: [
        {
          publisher: "Acme",
          format: "Hardcover",
          catalogNumber: `CAT-${index}`,
          location: `Shelf-${index}`,
        },
        {
          publisher: "Acme",
          format: "Hardcover",
          catalogNumber: `DECOY-${index}`,
          location: "WRONG",
        },
      ],
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/library/api/v1/editions/",
  resultsPath: "catalogSearch.postings",
  drillResultsPath: "edition",
  joinFields: ["catalogNumber"],
};

function buildActionSteps(): ReturnType<typeof compileActionSteps> {
  const captures = [
    catalogSearchCapture(),
    editionsDrillCapture(1, "2026-01-01T00:00:01Z"),
    editionsDrillCapture(2, "2026-01-01T00:00:02Z"),
  ] as never[];
  const actionCaptures = extractGraphQLActionSequence(captures, null, SPEC);
  const stateIndex = indexStateValues(
    captures,
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  return compileActionSteps(actionCaptures, stateIndex);
}

function generateContract(siteId: string): string {
  const actionSteps = buildActionSteps();
  const primaryResponseBody = actionSteps[0]!.capture.responseBody;
  return emitContractTs({
    siteId,
    pascal: "FoldreturnSinglePrimaryCollidingCandidatesTest",
    baseUrl: BASE,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: primaryResponseBody,
    gql: true,
    gqlQuery: CATALOG_QUERY,
    endpointPath: "/graphql",
    gqlOperationName: "catalogSearch",
    gqlVariables: {},
    auxFiles: [],
    actionSteps,
    foldReturnSpec: SPEC,
  });
}

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

function stubEditionsFetch(): void {
  const fn = vi.fn(async (url: string) => {
    const match = /\/editions\/(\d+)/.exec(url);
    const index = match ? match[1] : "1";
    return jsonResponse({
      edition: [
        {
          publisher: "Acme",
          format: "Hardcover",
          catalogNumber: `CAT-${index}`,
          location: `Shelf-${index}`,
        },
        {
          publisher: "Acme",
          format: "Hardcover",
          catalogNumber: `DECOY-${index}`,
          location: "WRONG",
        },
      ],
    });
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
  httpClient: ReturnType<typeof createHttpClient>
): (payload: Record<string, unknown>, context: { baseUrl: string }) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const factory = new Function(
    "getGql",
    "httpClient",
    "z",
    "FOLDRETURNSINGLEPRIMARYCOLLIDINGCANDIDATESTEST_QUERY",
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
  return factory(getGql, httpClient, z, CATALOG_QUERY);
}

describe("recon-generate foldReturn declared joinFields — colliding structural targets and candidates on the single-primary getGql/httpClient fold-merge loop", () => {
  it("emits the declared catalogNumber join key on EVERY per-item drill target, not the colliding publisher/format structural guess", () => {
    const contract = generateContract(
      `foldreturn-single-primary-colliding-candidates-${process.pid}`
    );
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    expect(executeHttpBody.match(/m\["catalogNumber"\]/g)?.length).toBe(2);
    expect(executeHttpBody).not.toContain('m["publisher"]');
    expect(executeHttpBody).not.toContain('m["format"]');
    expect(executeHttpBody.match(/\/library\/api\/v1\/editions\//g)?.length).toBe(2);
  });

  it("folds each posting onto the drill candidate whose catalogNumber matches, never the colliding publisher/format decoy", async () => {
    const contract = generateContract(
      `foldreturn-single-primary-colliding-candidates-rt-${process.pid}`
    );
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubEditionsFetch();

    const gqlCalls: { operationName: string; query: string; variables: unknown }[] = [];
    const getGql =
      (_baseUrl: string) =>
      async (operationName: string, query: string, variables: Record<string, unknown>) => {
        gqlCalls.push({ operationName, query, variables });
        return {
          catalogSearch: {
            postings: [
              {
                id: "post-1",
                catalogNumber: "CAT-1",
                edition: { publisher: "Acme", format: "Hardcover" },
                title: "Book A",
              },
              {
                id: "post-2",
                catalogNumber: "CAT-2",
                edition: { publisher: "Acme", format: "Hardcover" },
                title: "Book B",
              },
            ],
          },
        };
      };

    const executeHttp = evalSinglePrimaryExecuteHttp(executeHttpBody, getGql, httpClient);
    const result = await executeHttp({}, { baseUrl: BASE });

    expect(gqlCalls).toHaveLength(1);
    expect(result.data).toEqual({
      catalogSearch: {
        postings: [
          {
            id: "post-1",
            catalogNumber: "CAT-1",
            edition: { publisher: "Acme", format: "Hardcover" },
            title: "Book A",
            publisher: "Acme",
            format: "Hardcover",
            location: "Shelf-1",
          },
          {
            id: "post-2",
            catalogNumber: "CAT-2",
            edition: { publisher: "Acme", format: "Hardcover" },
            title: "Book B",
            publisher: "Acme",
            format: "Hardcover",
            location: "Shelf-2",
          },
        ],
      },
    });
    // Each posting re-issues BOTH per-item drill targets (editions/1 and
    // editions/2) — 2 postings * 2 targets = 4 — since the fold loop has no
    // way to know in advance which target's response matches a given
    // posting; only the declared catalogNumber join correctly discards the
    // non-matching target's response (and its own in-response decoy) for
    // each posting. The primary itself goes through the mocked getGql, not
    // fetch.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  });
});
