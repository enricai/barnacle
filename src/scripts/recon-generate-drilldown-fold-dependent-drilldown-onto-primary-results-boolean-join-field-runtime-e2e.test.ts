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
import { buildMulticallSingleShotSearchDrillDownArrayWrappedBooleanImmediateJoinFieldActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_BODY = { results: [{ flag: true }, { flag: false }] };

const statusTokenFor = (flag: boolean): string => `status-token-${flag}`;

const HISTORY_BULK_BODY_FOR = (flag: boolean): { entries: Array<Record<string, unknown>> } => ({
  entries: [{ statusToken: statusTokenFor(flag), ts: "2024-10-03T00:00:02Z", event: "shipped" }],
});

/**
 * Stubs `fetch` to answer the primary search call once, then each chain
 * step's call once per primary item, matched by request body content rather
 * than call order. The primary item's join field is the bare JSON BOOLEAN
 * `flag`, wrapped inside a single-element request-body array
 * (`{"flags":[...]}`).
 */
function stubDependentDrillDownOntoPrimaryBooleanJoinFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (Array.isArray(requestBody.flags) && typeof requestBody.flags[0] === "boolean") {
        return [statusTokenFor(requestBody.flags[0] as boolean)];
      }
      if (Array.isArray(requestBody.tokens) && typeof requestBody.tokens[0] === "string") {
        const statusToken = requestBody.tokens[0] as string;
        const flag = statusToken === statusTokenFor(true);
        return HISTORY_BULK_BODY_FOR(flag);
      }
      throw new Error(
        `stubDependentDrillDownOntoPrimaryBooleanJoinFetch: unrecognized request body ${JSON.stringify(requestBody)}`
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

describe("recon-generate dependent drill-down fold executeHttp — boolean join field runtime guard", () => {
  it("threads each primary item's own boolean-keyed chained data onto that item, not the other item's or a frozen recon-captured value", async () => {
    const steps =
      buildMulticallSingleShotSearchDrillDownArrayWrappedBooleanImmediateJoinFieldActionSteps();
    const captures = steps.map((step) => step.capture);
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

    stubDependentDrillDownOntoPrimaryBooleanJoinFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      {
        flag: true,
        statusToken: "status-token-true",
        ts: "2024-10-03T00:00:02Z",
        event: "shipped",
      },
      {
        flag: false,
        statusToken: "status-token-false",
        ts: "2024-10-03T00:00:02Z",
        event: "shipped",
      },
    ]);

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
