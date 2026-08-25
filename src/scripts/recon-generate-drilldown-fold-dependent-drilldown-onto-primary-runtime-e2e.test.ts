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
import { buildMulticallSingleShotSearchDrillDownOpaqueIntermediateChainedDependentActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_BODY = { results: [{ orderId: "order-a" }, { orderId: "order-b" }] };

const statusTokenFor = (orderId: string): string => `status-token-${orderId}`;

// >= 8 chars: `indexStateValues`' MIN_STATE_VALUE_LENGTH floor requires
// this length for the recon-capture value to register as a threaded state
// value at all — a shorter token never gets indexed, so the downstream
// request would silently fall back to an unrelated payload accessor
// instead of threading r1's actual produced value.
const STATUS_BODY_FOR = (orderId: string): string[] => [statusTokenFor(orderId)];

// r1's own response is a BARE array of a single opaque token — not an
// object-array or flat-object candidate at all (selectDisambiguatedCandidate
// finds nothing to fold there, since a bare string array never satisfies
// `isObjectArrayItem`/`findAllObjectArrayFields`) — while r2 threads that
// token and holds the real per-item data, so the chain must extend PAST
// this opaque intermediate hop rather than being discarded for lacking a
// candidate at the immediate hop.
const HISTORY_BODY_FOR = (orderId: string): { entries: Array<Record<string, unknown>> } => ({
  entries: [
    { statusToken: `status-token-${orderId}`, ts: "2024-10-01T00:00:02Z", event: "shipped" },
  ],
});

/**
 * Stubs `fetch` to answer the primary search call once, then each chain
 * step's call once per primary item, matched by request body content rather
 * than call order.
 */
function stubDependentDrillDownOntoPrimaryFetch(): void {
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
        `stubDependentDrillDownOntoPrimaryFetch: unrecognized request body ${JSON.stringify(requestBody)}`
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

describe("recon-generate dependent drill-down fold executeHttp — onto primary runtime guard", () => {
  it("folds the dependent (chained) drill-down's terminal fields onto the matching primary result item instead of dropping them", async () => {
    const steps =
      buildMulticallSingleShotSearchDrillDownOpaqueIntermediateChainedDependentActionSteps();
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

    stubDependentDrillDownOntoPrimaryFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      {
        orderId: "order-a",
        statusToken: "status-token-order-a",
        ts: "2024-10-01T00:00:02Z",
        event: "shipped",
      },
      {
        orderId: "order-b",
        statusToken: "status-token-order-b",
        ts: "2024-10-01T00:00:02Z",
        event: "shipped",
      },
    ]);

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
