import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/** Two primary items sharing the same `accountId` prefix pattern but distinct
 * `region`s, so a fold that only re-keyed on the first join field would
 * accidentally match either item against the other's drill response. */
function buildCompositeJoinTwoItemActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/records/search",
      requestPostData: '{"page":1}',
      responseBody: {
        results: [
          { accountId: "acc-1", region: "us" },
          { accountId: "acc-2", region: "eu" },
        ],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/records/detail",
      requestPostData: '{"accountId":"acc-1","region":"us"}',
      responseBody: {
        // A decoy object array structurally ahead of the declared
        // drillResultsPath, so the DFS-first fallback would pick this instead
        // if the fold ignored the declared `drillResultsPath`.
        errors: [{ code: "none" }],
        payload: {
          details: [
            { accountId: "acc-1", region: "eu", balance: 999 },
            { accountId: "acc-1", region: "us", balance: 100 },
          ],
        },
      },
      timestamp: "2024-04-01T00:00:01Z",
    }),
  ];
}

const COMPOSITE_DRILL_RESULTS_PATH_SPEC: FoldReturnSpec = {
  endpointPattern: "/records/detail",
  resultsPath: "results",
  drillResultsPath: "payload.details",
  joinFields: ["accountId", "region"],
};

const BALANCE_BY_ACCOUNT_AND_REGION: Record<string, number> = {
  "acc-1:us": 100,
  "acc-2:eu": 250,
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

/** Stubs `fetch` to answer the primary search call with the two-item fixture,
 * then answer every drill-down call by reading BOTH `accountId` and `region`
 * out of the request body and returning a `payload.details` array whose
 * FIRST candidate matches `accountId` but carries the OTHER item's `region` —
 * a decoy that a fold keyed on only the first join field would wrongly pick
 * — ahead of the real match for the requested account+region pair. */
function stubPerItemCompositeJoinDrillFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes("/records/detail")) {
      return jsonResponse({
        results: [
          { accountId: "acc-1", region: "us" },
          { accountId: "acc-2", region: "eu" },
        ],
      });
    }
    const { accountId, region } = JSON.parse(String(init?.body)) as {
      accountId: string;
      region: string;
    };
    const balance = BALANCE_BY_ACCOUNT_AND_REGION[`${accountId}:${region}`];
    if (balance === undefined) {
      throw new Error(
        `stubPerItemCompositeJoinDrillFetch: no balance fixture for "${accountId}:${region}"`
      );
    }
    const decoyRegion = region === "us" ? "eu" : "us";
    return jsonResponse({
      errors: [{ code: "none" }],
      payload: {
        details: [
          { accountId, region: decoyRegion, balance: -1 },
          { accountId, region, balance },
        ],
      },
    });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate composite-join + drillResultsPath executeHttp — generated-and-run runtime guard", () => {
  it("matches on ALL composite join fields and reads the drilled data from the declared drillResultsPath, for every primary item", async () => {
    const actionSteps = buildCompositeJoinTwoItemActionSteps();
    const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      COMPOSITE_DRILL_RESULTS_PATH_SPEC
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubPerItemCompositeJoinDrillFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      results: [
        { accountId: "acc-1", region: "us", balance: 100 },
        { accountId: "acc-2", region: "eu", balance: 250 },
      ],
    });
    // One primary call plus one drill-down call per primary item.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
