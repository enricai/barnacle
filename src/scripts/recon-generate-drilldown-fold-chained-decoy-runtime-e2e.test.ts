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
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_URL = "https://api.example.com/orders/search/";
const ORDER_STATUS_URL = "https://api.example.com/orders/status";
const ORDER_HISTORY_URL = "https://api.example.com/orders/history";

const SEARCH_BODY = { results: [{ orderId: "order-a" }, { orderId: "order-b" }] };

const STATUS_BODY_FOR = (orderId: string): { statusToken: string } => ({
  // >= 8 chars: `indexStateValues`' MIN_STATE_VALUE_LENGTH floor requires
  // this length for the recon-capture value to register as a threaded state
  // value at all.
  statusToken: `status-token-${orderId}`,
});

// Chain-terminal response carries a decoy array (`warnings`) positioned
// EARLIER in key order than the real per-item array (`entries`) — mirrors
// `buildMulticallSingleShotSearchDrillDownChainedDecoyOnChainTerminalActionSteps`
// in recon-generate-multicall-fixture.ts (structural detection coverage),
// proving the compiled fold loop actually merges `entries`' fields at
// runtime, never the decoy `warnings` array's.
const HISTORY_BODY_FOR = (
  orderId: string
): { warnings: unknown[]; entries: Array<Record<string, unknown>> } => ({
  warnings: [{ code: "stale-cache" }],
  entries: [
    { statusToken: `status-token-${orderId}`, ts: "2024-09-01T00:00:02Z", event: "shipped" },
  ],
});

/**
 * Builds the same primary-search + 2-hop chained-drill-down capture shape as
 * `buildMulticallSingleShotSearchDrillDownChainedDecoyOnChainTerminalActionSteps`
 * (structural detection coverage), but with a `statusToken` long enough to
 * actually thread through the real `indexStateValues` / `compileActionSteps`
 * pipeline at runtime, and two primary items so a wrong per-item merge is
 * distinguishable from a correct one.
 */
function buildRecordedChainedDrillDownCapturesWithChainTerminalDecoy(): ReturnType<
  typeof buildCapture
>[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: SEARCH_BODY,
      timestamp: "2024-09-01T00:00:00Z",
    }),
    buildCapture({
      url: ORDER_STATUS_URL,
      requestPostData: '{"orderId":"order-a"}',
      responseBody: STATUS_BODY_FOR("order-a"),
      timestamp: "2024-09-01T00:00:01Z",
    }),
    buildCapture({
      url: ORDER_HISTORY_URL,
      requestPostData: `{"statusToken":"${STATUS_BODY_FOR("order-a").statusToken}"}`,
      responseBody: HISTORY_BODY_FOR("order-a"),
      timestamp: "2024-09-01T00:00:02Z",
    }),
  ];
}

/**
 * Stubs `fetch` to answer the primary search call once, then each chain
 * step's call once per primary item, matched by request body content rather
 * than call order.
 */
function stubChainedDecoyFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.orderId === "string") return STATUS_BODY_FOR(requestBody.orderId);
      if (typeof requestBody.statusToken === "string") {
        const orderId = requestBody.statusToken.replace("status-token-", "");
        return HISTORY_BODY_FOR(orderId);
      }
      throw new Error(
        `stubChainedDecoyFetch: unrecognized request body ${JSON.stringify(requestBody)}`
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

describe("recon-generate chained drill-down fold executeHttp — chain-terminal decoy array runtime guard", () => {
  it("folds the chain terminal's real array onto each primary item, never the earlier-keyed decoy array, at runtime", async () => {
    const captures = buildRecordedChainedDrillDownCapturesWithChainTerminalDecoy();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    // Mirrors the real pipeline (recon-generate.ts's orchestrator, not a raw
    // fixture step list): `compileActionSteps` is what actually populates
    // each step's `produces[]` — including r1's `statusToken`, threaded from
    // its own response into r2's request.
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

    stubChainedDecoyFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      {
        orderId: "order-a",
        statusToken: "status-token-order-a",
        ts: "2024-09-01T00:00:02Z",
        event: "shipped",
      },
      {
        orderId: "order-b",
        statusToken: "status-token-order-b",
        ts: "2024-09-01T00:00:02Z",
        event: "shipped",
      },
    ]);
    // The decoy `warnings` array's field never lands on the folded item —
    // only the chain's genuine terminal `entries` array's fields do.
    expect(data.results?.[0]).not.toHaveProperty("code");

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
