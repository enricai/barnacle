import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitContractTs, type FoldReturnSpec } from "@/scripts/recon-generate";
import {
  extractExecuteHttpBodyFromContract,
  stripEmitterTypeAssertions,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";

/**
 * A search response nests its per-item results one level under a single
 * ancestor object (`groups[0].fares`) — a shape `findAllObjectArrayFields`
 * only ever represents with its own internal `groups.*.fares` wildcard
 * notation, never as a plain dotted path, since ordinary JSON dot-path
 * notation has no spelling for "every element of this array". A flow author
 * declaring `foldReturn.resultsPath` from the raw JSON they observed
 * naturally writes it as `"groups.fares"` (no wildcard token) instead.
 *
 * The single drill-down call is captured exactly ONCE — not one call per
 * fare, not re-issued — and its response holds candidate rows for every
 * fare at once, each carrying the SAME structurally-threaded `currency`/
 * `taxIncluded` pair (non-discriminating: every fare shares both values)
 * alongside the declared, response-only `fareCode` field that alone
 * identifies which candidate belongs to which fare. Exercised through
 * `emitContractTs`'s single-primary fold-merge loop (the `resolveFoldPlan`
 * hot path `emitMultiStepExecuteHttp` never runs for this flow), the shape
 * none of this suite's other declared-joinFields regressions combine:
 * a single shared (not per-item) drill call, a multi-candidate response,
 * AND a primary array whose spec-declared path omits the wildcard notation
 * its own structurally-detected array carries.
 */
const SPEC: FoldReturnSpec = {
  endpointPattern: "/drill",
  resultsPath: "groups.fares",
  joinFields: ["fareCode"],
};

function buildActionSteps(): {
  capture: ReturnType<typeof buildCapture>;
  varName: string;
  produces: never[];
  isMultipart: boolean;
  isCrossDomain: boolean;
}[] {
  const search = {
    capture: buildCapture({
      url: `${BASE}/catalog/search/`,
      requestPostData: '{"page":1}',
      responseBody: {
        groups: [
          {
            groupId: "g1",
            fares: [
              { fareCode: "F1", priceSummary: { currency: "USD", taxIncluded: true } },
              { fareCode: "F2", priceSummary: { currency: "USD", taxIncluded: true } },
            ],
          },
        ],
      },
      timestamp: "2026-01-01T00:00:01Z",
    }),
    varName: "r1",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  const drill = {
    capture: buildCapture({
      url: `${BASE}/drill?currency=USD&taxIncluded=true`,
      requestPostData: null,
      method: "GET",
      responseBody: {
        candidates: [
          { fareCode: "F1", currency: "USD", taxIncluded: true, seatsLeft: 3 },
          { fareCode: "F2", currency: "USD", taxIncluded: true, seatsLeft: 5 },
        ],
      },
      timestamp: "2026-01-01T00:00:02Z",
    }),
    varName: "r2",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  return [search, drill];
}

function generateContract(siteId: string): string {
  const actionSteps = buildActionSteps();
  return emitContractTs({
    siteId,
    pascal: "FoldreturnNestedArrayNotationMismatchTest",
    baseUrl: BASE,
    baseHeaders: {},
    minTime: 100,
    safeRps: 10,
    responseBody: actionSteps[0]!.capture.responseBody,
    gql: false,
    gqlQuery: null,
    endpointPath: "/catalog/search",
    gqlOperationName: null,
    gqlVariables: null,
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

function stubDrillFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (!url.includes("/drill")) {
      return jsonResponse({
        groups: [
          {
            groupId: "g1",
            fares: [
              { fareCode: "F1", priceSummary: { currency: "USD", taxIncluded: true } },
              { fareCode: "F2", priceSummary: { currency: "USD", taxIncluded: true } },
            ],
          },
        ],
      });
    }
    return jsonResponse({
      candidates: [
        { fareCode: "F1", currency: "USD", taxIncluded: true, seatsLeft: 3 },
        { fareCode: "F2", currency: "USD", taxIncluded: true, seatsLeft: 5 },
      ],
    });
  });
  vi.stubGlobal("fetch", fn);
}

/** The single-primary `executeHttp` body references `context.baseUrl`, not
 * just `payload` — both bindings are required to evaluate it. */
function evalSinglePrimaryExecuteHttp(
  body: string,
  httpClient: ReturnType<typeof createHttpClient>
): (payload: Record<string, unknown>, context: { baseUrl: string }) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const factory = new Function(
    "httpClient",
    "z",
    `return async function executeHttp(payload, context) {\n${stripped}\n};`
  ) as (
    httpClientArg: unknown,
    zArg: unknown
  ) => (
    payload: Record<string, unknown>,
    context: { baseUrl: string }
  ) => Promise<{ data: unknown }>;
  return factory(httpClient, z);
}

describe("recon-generate foldReturn declared joinFields — shared single-call multi-candidate response, declared resultsPath omitting the internal array-wildcard notation", () => {
  it("emits the declared fareCode join key on the fold-match block, never the shared currency/taxIncluded structural guess", () => {
    const contract = generateContract(`foldreturn-nested-array-notation-mismatch-${process.pid}`);
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    expect(executeHttpBody).toContain('m["fareCode"]');
    expect(executeHttpBody).not.toContain('m["currency"]');
    expect(executeHttpBody).not.toContain('m["taxIncluded"]');
    // Exactly one fold target — the shared drill call is folded once per
    // primary fare, not duplicated as a second independent target.
    expect(executeHttpBody.match(/const foldMatches/g)?.length).toBe(1);
  });

  it("folds each fare with its own matching candidate at runtime, keyed on the declared fareCode, never the non-discriminating currency/taxIncluded pair", async () => {
    const contract = generateContract(
      `foldreturn-nested-array-notation-mismatch-rt-${process.pid}`
    );
    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDrillFetch();

    const executeHttp = evalSinglePrimaryExecuteHttp(executeHttpBody, httpClient);
    const result = await executeHttp({ page: 1 }, { baseUrl: BASE });

    expect(result.data).toEqual({
      groups: [
        {
          groupId: "g1",
          fares: [
            {
              fareCode: "F1",
              priceSummary: { currency: "USD", taxIncluded: true },
              currency: "USD",
              taxIncluded: true,
              seatsLeft: 3,
            },
            {
              fareCode: "F2",
              priceSummary: { currency: "USD", taxIncluded: true },
              currency: "USD",
              taxIncluded: true,
              seatsLeft: 5,
            },
          ],
        },
      ],
    });
    // The primary search plus exactly ONE shared drill call — the drill is
    // captured once and its candidates matched per-fare in-memory, never
    // re-issued per fare and never split into a second independent target.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
