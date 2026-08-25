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
import { buildMulticallSingleShotSearchDrillDownShortNumericChainedJoinFieldActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_BODY = { results: [{ orderId: "order-a" }, { orderId: "order-b" }] };

const statusTokenFor = (orderId: string): number => (orderId === "order-a" ? 42 : 43);

const ORDER_HISTORY_BODY_FOR = (token: number): { entries: Array<Record<string, unknown>> } => ({
  entries: [{ token, ts: "2024-10-04T00:00:02Z", event: "shipped" }],
});

/**
 * Stubs `fetch` to answer the primary search call once, then each chain
 * step's call once per primary item, matched by request body content rather
 * than call order — same shape as
 * `stubArrayWrappedNumericChainedJoinFieldFetch`
 * (recon-generate-drilldown-fold-dependent-drilldown-onto-primary-results-numeric-chained-join-field-runtime-e2e.test.ts),
 * but `r1`'s produced token is a SHORT (two-digit) bare JSON number instead
 * of an 8-digit one, and `r2`'s request threads it as a bare (non-array-
 * wrapped) field.
 */
function stubShortNumericChainedJoinFieldFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.orderId === "string") {
        return [statusTokenFor(requestBody.orderId)];
      }
      if (typeof requestBody.token === "number") {
        return ORDER_HISTORY_BODY_FOR(requestBody.token);
      }
      throw new Error(
        `stubShortNumericChainedJoinFieldFetch: unrecognized request body ${JSON.stringify(requestBody)}`
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

describe("recon-generate dependent drill-down fold executeHttp — short numeric chained join field runtime guard", () => {
  it("threads a short numeric chain-produced join value into a later request body", async () => {
    const steps = buildMulticallSingleShotSearchDrillDownShortNumericChainedJoinFieldActionSteps();
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

    stubShortNumericChainedJoinFieldFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      {
        orderId: "order-a",
        token: 42,
        ts: "2024-10-04T00:00:02Z",
        event: "shipped",
      },
      {
        orderId: "order-b",
        token: 43,
        ts: "2024-10-04T00:00:02Z",
        event: "shipped",
      },
    ]);

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
