import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  collectHeaderBindings,
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchDrillDownResponseHeaderThreadedJoinChainedDependentActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_BODY = { results: [{ sku: "sku-a" }, { sku: "sku-b" }] };

const priceTokenFor = (sku: string): string => `tok-${sku}`;

/**
 * Stubs `fetch` to answer the primary search call once, then the chain's
 * response-header-minted drill hop (matched by request body content — its
 * OWN response body is empty and its join token lives only in a response
 * header) and the chain's terminal hop (matched by the `X-Price-Token`
 * request HEADER it was threaded onto, since its request body carries no
 * per-item signal at all) once per primary item.
 */
function stubResponseHeaderThreadedDependentDrillDownOntoPrimaryFetch(): void {
  const fn = vi
    .fn()
    .mockImplementation(
      (_url: string, init?: { body?: string; headers?: Record<string, string> }) => {
        const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        const priceTokenHeader = Object.entries(init?.headers ?? {}).find(
          ([name]) => name.toLowerCase() === "x-price-token"
        )?.[1];
        const { responseBody, responseHeaders } = (() => {
          if (requestBody === null || typeof requestBody.page === "number") {
            return { responseBody: SEARCH_BODY, responseHeaders: new Headers() };
          }
          if (typeof requestBody.sku === "string") {
            return {
              responseBody: {},
              responseHeaders: new Headers({ "X-Price-Token": priceTokenFor(requestBody.sku) }),
            };
          }
          if (priceTokenHeader !== undefined) {
            const sku = priceTokenHeader.replace(/^tok-/, "");
            return {
              responseBody: {
                history: [{ sku, amount: 18.5, asOf: "2024-11-01" }],
              },
              responseHeaders: new Headers(),
            };
          }
          throw new Error(
            `stubResponseHeaderThreadedDependentDrillDownOntoPrimaryFetch: unrecognized request ${JSON.stringify(requestBody)} headers=${JSON.stringify(init?.headers)}`
          );
        })();
        return Promise.resolve({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
          headers: responseHeaders,
        });
      }
    );
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate dependent drill-down fold executeHttp — response-header-minted join field runtime guard", () => {
  it("threads a response-header-minted chain hop's join value into the chain's terminal request header instead of dropping it", async () => {
    const steps =
      buildMulticallSingleShotSearchDrillDownResponseHeaderThreadedJoinChainedDependentActionSteps();
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
      bind: collectHeaderBindings(actionSteps),
    });

    stubResponseHeaderThreadedDependentDrillDownOntoPrimaryFetch();

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
        amount: 18.5,
        asOf: "2024-11-01",
      },
    ]);

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
