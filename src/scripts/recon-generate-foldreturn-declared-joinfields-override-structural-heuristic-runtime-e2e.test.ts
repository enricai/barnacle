import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A search → per-item drill-down pair where the drill endpoint is captured
 * TWICE (`r1`, a plain lookup; `r2`, a "refresh" re-query) at the SAME
 * endpoint identity. The structural heuristic threads `code` from the
 * primary item's own field into `r1`'s URL path segment and resolves ITS
 * target's `drillStepIndex` at `r1` (the first occurrence it visits). A
 * declared `foldReturn.joinFields: ["confirmationId"]` names a field the
 * heuristic could never infer — `confirmationId` threads through no
 * request anywhere — so `buildFoldPlanFromSpec` can only resolve it against
 * a drill RESPONSE, and it tries the freshest occurrence (`r2`) first,
 * landing its own resolved target at a DIFFERENT `drillStepIndex` than the
 * structural heuristic's. Both targets describe the SAME logical drill-down
 * (same endpoint identity), so the declared `confirmationId` must still win
 * as the emitted join key on the structural target, not be silently
 * shadowed by the heuristic's own inferred `code`.
 */
function buildDualOccurrenceDrillDownActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/hotels/search/",
      requestPostData: '{"city":"nyc"}',
      responseBody: {
        hotels: [{ code: "hz-1", confirmationId: "conf-77" }],
      },
      timestamp: "2024-04-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/hotels/rooms/hz-1/",
      requestPostData: '{"lookup":true}',
      responseBody: {
        rooms: [{ code: "hz-1", confirmationId: "conf-77", price: 100 }],
      },
      timestamp: "2024-04-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/hotels/rooms/hz-1/?refresh=true",
      requestPostData: '{"lookup":true,"refresh":true}',
      responseBody: {
        rooms: [{ code: "hz-1", confirmationId: "conf-77", price: 150 }],
      },
      timestamp: "2024-04-01T00:00:02Z",
    }),
  ];
}

const DUAL_OCCURRENCE_SPEC: FoldReturnSpec = {
  endpointPattern: "/hotels/rooms/",
  resultsPath: "hotels",
  drillResultsPath: "rooms",
  joinFields: ["confirmationId"],
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

function stubDualOccurrenceFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (!url.includes("/hotels/rooms/")) {
      return jsonResponse({ hotels: [{ code: "hz-1", confirmationId: "conf-77" }] });
    }
    return jsonResponse({ rooms: [{ code: "hz-1", confirmationId: "conf-77", price: 100 }] });
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate foldReturn declared joinFields override — dual structural/spec drillStepIndex resolution", () => {
  it("emits the declared joinFields on the structurally-resolved target instead of the heuristic's inferred field", () => {
    const actionSteps = buildDualOccurrenceDrillDownActionSteps();
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
      DUAL_OCCURRENCE_SPEC
    );

    expect(body).toContain('m["confirmationId"]');
    expect(body).not.toContain('m["code"]');
    // Exactly one fold target is emitted for this primary — the spec's own
    // resolution must override the structural target's joinFields in place,
    // not append a second, redundant fold target for the same endpoint.
    expect(body.match(/const foldMatches/g)?.length).toBe(1);
    expect(body.match(/httpClient\(/g)?.length).toBe(2);
  });

  it("folds the declared field's join at runtime, using the structurally-resolved (first) drill occurrence as its call template", async () => {
    const actionSteps = buildDualOccurrenceDrillDownActionSteps();
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
      DUAL_OCCURRENCE_SPEC
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubDualOccurrenceFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", city: "nyc" });

    expect(result.data).toEqual({
      hotels: [{ code: "hz-1", confirmationId: "conf-77", price: 100 }],
    });
    // One primary call plus exactly one drill-down call — a second,
    // redundant target for the same endpoint would double this.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
