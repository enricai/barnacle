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
 * The sibling of `recon-generate-foldreturn-declared-joinfields-single-
 * primary-getgql-httpclient-runtime-e2e.test.ts`'s colliding-candidates
 * scenario, but with a two-hop chain (token mint, then drill) standing
 * between the primary and each posting's per-item fold target — the same
 * combined shape (long chain + nested-pair structural guess + response-only
 * declared identifier) already pinned on `emitMultiStepExecuteHttp`'s loop.
 * Both postings thread the identical nested `edition.publisher`/
 * `edition.format` pair into BOTH hops of their own chain (colliding
 * structural values), so the structural heuristic guesses that pair as its
 * own `joinFields` — and each drill's response additionally returns TWO
 * candidates sharing that same pair, distinguishable only by
 * `catalogNumber`. `catalogNumber` never threads into any request — only
 * the declared `foldReturn.joinFields: ["catalogNumber"]`, resolved
 * entirely from each drill's own response, correctly merges every posting
 * on `emitContractTs`'s single-primary `getGql`/`httpClient` fold-merge
 * loop, the same hot path `recon-generate-foldreturn-declared-joinfields-
 * single-primary-getgql-httpclient-runtime-e2e.test.ts` exercises.
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

function tokenMintCapture(index: number, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `${BASE}/library/api/v1/editions/${index}/token?publisher=Acme&format=Hardcover`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { sessionToken: `session-token-000${index}` },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/**
 * Each posting's chain terminates at its OWN endpoint identity
 * (`/editions/1`, `/editions/2`), reached only after that posting's own
 * token-mint hop, but both hops of both postings' chains thread the
 * identical nested `edition.publisher`/`edition.format` pair — the
 * structural coincidence. Each drill response returns TWO candidates
 * ("real" plus a "decoy") that ALSO share that identical pair,
 * distinguishable only by `catalogNumber`.
 */
function editionsDrillCapture(index: number, timestamp: string): unknown {
  return {
    timestamp,
    phase: "browse",
    method: "GET",
    url: `${BASE}/library/api/v1/editions/${index}?token=session-token-000${index}&publisher=Acme&format=Hardcover`,
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
    tokenMintCapture(1, "2026-01-01T00:00:01Z"),
    editionsDrillCapture(1, "2026-01-01T00:00:02Z"),
    tokenMintCapture(2, "2026-01-01T00:00:03Z"),
    editionsDrillCapture(2, "2026-01-01T00:00:04Z"),
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
    pascal: "FoldreturnLongChainSinglePrimaryTest",
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

function stubChainedEditionsFetch(): void {
  const fn = vi.fn(async (url: string) => {
    const tokenMatch = /\/editions\/(\d+)\/token/.exec(url);
    if (tokenMatch) {
      return jsonResponse({ sessionToken: `session-token-000${tokenMatch[1]}` });
    }
    const drillMatch = /\/editions\/(\d+)\?/.exec(url);
    const index = drillMatch ? drillMatch[1] : "1";
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
    "FOLDRETURNLONGCHAINSINGLEPRIMARYTEST_QUERY",
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

describe("recon-generate foldReturn declared joinFields — long chain plus colliding nested structural guess on the single-primary getGql/httpClient fold-merge loop", () => {
  it("emits the declared catalogNumber join key on EVERY per-item chain target, not the colliding publisher/format structural guess", () => {
    const contract = generateContract(`foldreturn-long-chain-single-primary-${process.pid}`);
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    expect(executeHttpBody.match(/m\["catalogNumber"\]/g)?.length).toBe(2);
    expect(executeHttpBody).not.toContain('m["publisher"]');
    expect(executeHttpBody).not.toContain('m["format"]');
    expect(executeHttpBody.match(/\/library\/api\/v1\/editions\//g)?.length).toBe(4);
  });

  it("folds each posting onto the chain's drill candidate whose catalogNumber matches, never the colliding publisher/format decoy", async () => {
    const contract = generateContract(`foldreturn-long-chain-single-primary-rt-${process.pid}`);
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubChainedEditionsFetch();

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
  });
});
