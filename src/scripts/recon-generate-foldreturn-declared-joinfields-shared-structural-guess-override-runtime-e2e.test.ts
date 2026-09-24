import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A search → per-item drill-down where the drill endpoint is captured
 * TWICE (`r1`, a plain lookup; `r2`, a "refresh" re-query) at the SAME
 * endpoint identity. The primary item carries a compound nested
 * `priceSummary.currency`/`priceSummary.taxIncluded` pair that threads
 * verbatim into `r1`'s own query string, so the structural heuristic
 * resolves ITS target's `drillStepIndex` at `r1` (the first occurrence it
 * visits) with BOTH nested fields as its own guessed `joinFields`. A
 * declared `foldReturn.joinFields: ["sessionId"]` names a distinct,
 * always-present field the heuristic could never infer — `sessionId`
 * threads through no request anywhere, only ever appearing in response
 * bodies (the primary item's own record and both drill occurrences') — so
 * `buildFoldPlanFromSpec` can only resolve it against a drill RESPONSE, and
 * it tries the freshest occurrence (`r2`) first, landing its own resolved
 * target at a DIFFERENT `drillStepIndex` than the structural heuristic's.
 * Both targets describe the SAME logical drill-down (same endpoint
 * identity), so the declared `sessionId` must still win as the emitted join
 * key on the structural target, not be silently shadowed by the shared
 * nested-pair structural guess.
 */
function buildSharedStructuralGuessActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/sessions/search/",
      requestPostData: '{"track":"main"}',
      responseBody: {
        sessions: [{ sessionId: "sess-1", priceSummary: { currency: "USD", taxIncluded: true } }],
      },
      timestamp: "2024-06-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/sessions/pricing/sess-1/?currency=USD&taxIncluded=true",
      requestPostData: null,
      responseBody: {
        candidates: [{ sessionId: "sess-1", currency: "USD", taxIncluded: true, price: 100 }],
      },
      timestamp: "2024-06-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/sessions/pricing/sess-1/?refresh=true",
      requestPostData: null,
      responseBody: {
        candidates: [{ sessionId: "sess-1", currency: "USD", taxIncluded: true, price: 150 }],
      },
      timestamp: "2024-06-01T00:00:02Z",
    }),
  ];
}

const SHARED_STRUCTURAL_GUESS_SPEC: FoldReturnSpec = {
  endpointPattern: "/sessions/pricing/",
  resultsPath: "sessions",
  drillResultsPath: "candidates",
  joinFields: ["sessionId"],
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

function stubSharedStructuralGuessFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (!url.includes("/sessions/pricing/")) {
      return jsonResponse({
        sessions: [{ sessionId: "sess-1", priceSummary: { currency: "USD", taxIncluded: true } }],
      });
    }
    return jsonResponse({
      candidates: [{ sessionId: "sess-1", currency: "USD", taxIncluded: true, price: 100 }],
    });
  });
  vi.stubGlobal("fetch", fn);
}

function buildEmission(): string {
  const actionSteps = buildSharedStructuralGuessActionSteps();
  const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;

  return emitMultiStepExecuteHttp(
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
    SHARED_STRUCTURAL_GUESS_SPEC
  );
}

describe("recon-generate foldReturn declared joinFields — shared nested-pair structural guess override (dual drill occurrence)", () => {
  it("emits the declared sessionId join key on the structurally-resolved target instead of the shared priceSummary currency/taxIncluded pair", () => {
    const body = buildEmission();

    expect(body).toContain('m["sessionId"]');
    expect(body).not.toContain('m["currency"]');
    expect(body).not.toContain('m["taxIncluded"]');
    // Exactly one fold target is emitted for this primary — the spec's own
    // resolution must override the structural target's joinFields in place,
    // not append a second, redundant fold target for the same endpoint.
    expect(body.match(/const foldMatches/g)?.length).toBe(1);
    expect(body.match(/httpClient\(/g)?.length).toBe(2);
  });

  it("folds the declared field's join at runtime, using the structurally-resolved (first) drill occurrence as its call template", async () => {
    const body = buildEmission();

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubSharedStructuralGuessFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", track: "main" });

    expect(result.data).toEqual({
      sessions: [
        {
          sessionId: "sess-1",
          priceSummary: { currency: "USD", taxIncluded: true },
          currency: "USD",
          taxIncluded: true,
          price: 100,
        },
      ],
    });
    // One primary call plus exactly one drill-down call — a second,
    // redundant target for the same endpoint would double this.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
