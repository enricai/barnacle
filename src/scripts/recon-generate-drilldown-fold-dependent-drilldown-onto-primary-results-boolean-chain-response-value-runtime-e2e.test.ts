import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchDrillDownBooleanChainedResponseValueActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_BODY = { results: [{ sku: "sku-a" }, { sku: "sku-b" }] };

const verifiedFor = (sku: string): boolean => sku === "sku-a";

const HISTORY_BODY_FOR = (verified: boolean): { history: Array<Record<string, unknown>> } => ({
  history: [
    {
      sku: verified ? "sku-a" : "sku-b",
      amount: verified ? 18.5 : 42.25,
      asOf: "2024-11-01",
    },
  ],
});

/**
 * Stubs `fetch` to answer the primary search call once, then each chain
 * step's call once per primary item, matched by request body content rather
 * than call order. `r1`'s response mints only a boolean `verified` value
 * (no array of its own) that `r2` threads into its request body to reach
 * the real per-item `history[]` array — same shape as
 * `buildMulticallSingleShotSearchDrillDownBooleanChainedResponseValueActionSteps`
 * (recon-generate-fold-plan.test.ts), replayed here per primary item.
 */
function stubBooleanChainedResponseValueFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.sku === "string") {
        return { verified: verifiedFor(requestBody.sku) };
      }
      if (typeof requestBody.verified === "string") {
        return HISTORY_BODY_FOR(requestBody.verified === "true");
      }
      throw new Error(
        `stubBooleanChainedResponseValueFetch: unrecognized request body ${JSON.stringify(requestBody)}`
      );
    })();
    return Promise.resolve({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
      headers: new Headers(),
    });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate dependent drill-down fold executeHttp — boolean chain-response-value runtime guard", () => {
  it("threads each primary item's own boolean-minting chain hop into its own per-item terminal value", async () => {
    const steps = buildMulticallSingleShotSearchDrillDownBooleanChainedResponseValueActionSteps();
    const captures = steps.map((step) => step.capture);
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

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
      new Map()
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubBooleanChainedResponseValueFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      {
        sku: "sku-a",
        amount: 18.5,
        asOf: "2024-11-01",
      },
      {
        sku: "sku-b",
        amount: 42.25,
        asOf: "2024-11-01",
      },
    ]);

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
