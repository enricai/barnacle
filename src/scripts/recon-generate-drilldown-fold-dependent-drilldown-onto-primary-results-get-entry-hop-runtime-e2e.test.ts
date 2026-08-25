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
import { buildMulticallSingleShotSearchDrillDownGetEntryHopChainedDependentActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_BODY = { results: [{ orderId: "order-a" }, { orderId: "order-b" }] };

const statusTokenFor = (orderId: string): string => `status-token-${orderId}`;

/**
 * Stubs `fetch` to answer the primary search call once, then the chain's
 * GET entry hop (matched by URL query param, since a GET has no body) and
 * the chain's POST terminal (matched by request body content) once per
 * primary item.
 */
function stubGetEntryHopDependentDrillDownOntoPrimaryFetch(): void {
  const fn = vi.fn().mockImplementation((url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (url.includes("/orders/status-lookup")) {
        const orderId = new URL(url).searchParams.get("orderId");
        if (orderId === null) throw new Error("missing orderId query param");
        return { statusToken: statusTokenFor(orderId) };
      }
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.token === "string") {
        return {
          entries: [{ token: requestBody.token, ts: "2024-10-05T00:00:02Z", event: "shipped" }],
        };
      }
      throw new Error(
        `stubGetEntryHopDependentDrillDownOntoPrimaryFetch: unrecognized request ${url} ${JSON.stringify(requestBody)}`
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

describe("recon-generate dependent drill-down fold executeHttp — GET entry hop runtime guard", () => {
  it("threads a GET entry hop's produced non-UUID join value into the chain's terminal request instead of rendering it as undefined", async () => {
    const steps = buildMulticallSingleShotSearchDrillDownGetEntryHopChainedDependentActionSteps();
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

    stubGetEntryHopDependentDrillDownOntoPrimaryFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      {
        orderId: "order-a",
        token: "status-token-order-a",
        ts: "2024-10-05T00:00:02Z",
        event: "shipped",
      },
      {
        orderId: "order-b",
        token: "status-token-order-b",
        ts: "2024-10-05T00:00:02Z",
        event: "shipped",
      },
    ]);

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
