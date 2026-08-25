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
import {
  buildMulticallSingleShotSearchDrillDownRichnessTiedConfirmationHopChainedDependentActionSteps,
  buildMulticallSingleShotSearchTwoIndependentArraysActionSteps,
} from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_RESPONSE_BODY = {
  products: [{ sku: "sku-a" }],
  vendors: [{ vendorId: "v1" }],
};
const PRICING_RESPONSE_BODY = { prices: [{ sku: "sku-a", amount: 9.99 }] };
const VENDOR_DETAIL_RESPONSE_BODY = { contracts: [{ vendorId: "v1", contractId: "c1" }] };

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

/** Stubs `fetch` to answer the primary search call with `SEARCH_RESPONSE_BODY`,
 * then routes the vendor-detail drill call by URL, proving the dependent
 * drill-down response — which the finding reported as being dropped rather
 * than folded — lands on its matching `vendors[]` primary item at runtime. */
function stubDependentDrillDownFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (url.includes("/catalog/pricing/")) {
      return jsonResponse(PRICING_RESPONSE_BODY);
    }
    if (url.includes("/catalog/vendors/detail/")) {
      return jsonResponse(VENDOR_DETAIL_RESPONSE_BODY);
    }
    return jsonResponse(SEARCH_RESPONSE_BODY);
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate drill-down fold executeHttp — dependent drill-down onto primary runtime guard", () => {
  it("folds the dependent drill-down's fields onto the matching primary result item instead of dropping them", async () => {
    const actionSteps = buildMulticallSingleShotSearchTwoIndependentArraysActionSteps();
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
      new Map()
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDependentDrillDownFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    // Before the fix, scanPrimaryCandidate's candidatePool lock resolved
    // only whichever array field the FIRST qualifying drill-down threaded
    // from (`products[]`, via the pricing call), so the vendor-detail
    // call's `contractId` was silently discarded and never folded onto
    // `vendors[]` — this asserts it now is.
    expect(result.data).toEqual({
      products: [{ sku: "sku-a", amount: 9.99 }],
      vendors: [{ vendorId: "v1", contractId: "c1" }],
    });
  });
});

const statusTokenFor = (orderId: string): string => `status-token-${orderId}`;
const receiptTokenFor = (orderId: string): string => `receipt-token-${orderId}`;

const RICHNESS_TIE_SEARCH_BODY = { results: [{ orderId: "order-a" }, { orderId: "order-b" }] };

const RICHNESS_TIE_STATUS_BODY_FOR = (orderId: string): string[] => [statusTokenFor(orderId)];

const RICHNESS_TIE_CONFIRMATION_BODY_FOR = (orderId: string): Record<string, unknown> => ({
  statusToken: statusTokenFor(orderId),
  held: true,
  receiptToken: receiptTokenFor(orderId),
});

const RICHNESS_TIE_HISTORY_BODY_FOR = (
  orderId: string
): { entries: Array<Record<string, unknown>> } => ({
  entries: [
    { receiptToken: receiptTokenFor(orderId), event: "shipped", ts: "2024-10-02T00:00:03Z" },
  ],
});

/**
 * Stubs `fetch` to answer the primary search call once, then each of the
 * three chained calls per primary item, matched by request body content
 * rather than call order.
 */
function stubRichnessTiedConfirmationHopFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") {
        return RICHNESS_TIE_SEARCH_BODY;
      }
      if (typeof requestBody.orderId === "string") {
        return RICHNESS_TIE_STATUS_BODY_FOR(requestBody.orderId);
      }
      if (typeof requestBody.statusToken === "string") {
        const orderId = requestBody.statusToken.replace("status-token-", "");
        return RICHNESS_TIE_CONFIRMATION_BODY_FOR(orderId);
      }
      if (typeof requestBody.receiptToken === "string") {
        const orderId = requestBody.receiptToken.replace("receipt-token-", "");
        return RICHNESS_TIE_HISTORY_BODY_FOR(orderId);
      }
      throw new Error(
        `stubRichnessTiedConfirmationHopFetch: unrecognized request body ${JSON.stringify(requestBody)}`
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

describe("recon-generate dependent drill-down fold executeHttp — richness-tied confirmation hop runtime guard", () => {
  it("folds the real chained terminal's fields onto every primary result item instead of the confirmation hop's boolean/echoed-token fields", async () => {
    const steps =
      buildMulticallSingleShotSearchDrillDownRichnessTiedConfirmationHopChainedDependentActionSteps();
    const captures = steps.map((step) => step.capture);
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    // Mirrors the real pipeline (recon-generate.ts's orchestrator, not a raw
    // fixture step list): `compileActionSteps` is what actually populates
    // each step's `produces[]` — including r1's `statusToken` and r2's
    // `receiptToken`, each threaded from its own response into the next
    // hop's request.
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

    stubRichnessTiedConfirmationHopFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      {
        orderId: "order-a",
        receiptToken: "receipt-token-order-a",
        event: "shipped",
        ts: "2024-10-02T00:00:03Z",
      },
      {
        orderId: "order-b",
        receiptToken: "receipt-token-order-b",
        event: "shipped",
        ts: "2024-10-02T00:00:03Z",
      },
    ]);

    // One primary call, plus one call per chain hop (3) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 3 * 2);
  });
});
