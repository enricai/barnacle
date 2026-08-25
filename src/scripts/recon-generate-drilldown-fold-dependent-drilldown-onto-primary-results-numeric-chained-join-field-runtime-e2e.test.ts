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
import { buildMulticallSingleShotSearchDrillDownArrayWrappedNumericChainedJoinFieldActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_BODY = { results: [{ orderId: "order-a" }, { orderId: "order-b" }] };

const statusTokenFor = (orderId: string): number => (orderId === "order-a" ? 12345678 : 87654321);

const ORDER_HISTORY_BULK_BODY_FOR = (
  statusToken: number
): { entries: Array<Record<string, unknown>> } => ({
  entries: [{ statusToken, ts: "2024-10-03T00:00:02Z", event: "shipped" }],
});

/**
 * Stubs `fetch` to answer the primary search call once, then each chain
 * step's call once per primary item, matched by request body content rather
 * than call order. Same shape as
 * `stubArrayWrappedDependentDrillDownOntoPrimaryFetch`
 * (recon-generate-drilldown-fold-dependent-drilldown-onto-primary-results-runtime-e2e.test.ts),
 * but `r1`'s produced `statusToken` is a bare JSON NUMBER instead of a
 * string.
 */
function stubArrayWrappedNumericChainedJoinFieldFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.orderId === "string") {
        return [statusTokenFor(requestBody.orderId)];
      }
      if (Array.isArray(requestBody.tokens) && typeof requestBody.tokens[0] === "number") {
        return ORDER_HISTORY_BULK_BODY_FOR(requestBody.tokens[0] as number);
      }
      throw new Error(
        `stubArrayWrappedNumericChainedJoinFieldFetch: unrecognized request body ${JSON.stringify(requestBody)}`
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

describe("recon-generate dependent drill-down fold executeHttp — array-wrapped numeric chained join field runtime guard", () => {
  // This is NOT the array-wrap fix (bugfix-001) under test in the sibling
  // string-valued file — it covers a prerequisite gap found while writing
  // that regression coverage for a numeric variant. `indexStateValues`,
  // `jsonBodyLeafValues`, `compileActionSteps`' produces[] walk, and
  // `resolveResponsePathValue` (src/scripts/recon-generate.ts) now thread a
  // bare-number chain-produced value (`r1`'s response here) identically to a
  // string leaf, so `r2`'s templated body resolves the token accessor
  // instead of rendering `{"tokens":[undefined]}`.
  it("threads a numeric chain-produced join value into a later request body", async () => {
    const steps =
      buildMulticallSingleShotSearchDrillDownArrayWrappedNumericChainedJoinFieldActionSteps();
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

    stubArrayWrappedNumericChainedJoinFieldFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      {
        orderId: "order-a",
        statusToken: 12345678,
        ts: "2024-10-03T00:00:02Z",
        event: "shipped",
      },
      {
        orderId: "order-b",
        statusToken: 87654321,
        ts: "2024-10-03T00:00:02Z",
        event: "shipped",
      },
    ]);

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
