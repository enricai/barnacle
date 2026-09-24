import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A search → per-item drill-down where the primary item carries a
 * structurally-guessable nested `priceSummary.currency`/`priceSummary.taxIncluded`
 * pair that threads verbatim into the drill's own query string, so the
 * structural heuristic resolves its target's guessed `joinFields` from those
 * two fields. The flow declares `foldReturn.joinFields: ["voyageId"]`, a
 * field the drill's own recorded (generation-time) response never echoes
 * back at all — so `resolveSpecMatchedPrimaryItemIndexFromResponse` can't
 * find any primary item's `voyageId` value among that capture's response
 * leaf values, `buildFoldPlanFromSpec`'s restricted resolution comes back
 * `null`, and (pre-fix) `mergeSpecPlanOntoSamePrimary` silently kept the
 * structural currency/taxIncluded guess instead of applying the declared
 * `voyageId` override. This is exactly the gap closed by "Trust declared
 * fold-join joinFields when representative-item resolution fails"
 * (599d6f0): the runtime emitter never reads the representative-item index,
 * only the `joinFields` field-name string, so the override must apply
 * regardless of whether a representative item could be picked.
 */
function buildActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/orders/search/",
      requestPostData: '{"track":"main"}',
      responseBody: {
        orders: [
          {
            orderId: "ord-1",
            voyageId: "voy-1",
            priceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      },
      timestamp: "2024-06-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/orders/shipments/ord-1/?currency=USD&taxIncluded=true",
      requestPostData: null,
      // No `voyageId` anywhere in this recorded response — the generation-time
      // example the per-item loop is templated from never echoes it back, so
      // the representative-item resolution this override no longer depends
      // on (post-fix) fails here by construction.
      responseBody: {
        candidates: [{ trackingRef: "trk-1", currency: "USD", taxIncluded: true, weight: 12 }],
      },
      timestamp: "2024-06-01T00:00:01Z",
    }),
  ];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/orders/shipments/",
  resultsPath: "orders",
  drillResultsPath: "candidates",
  joinFields: ["voyageId"],
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

/**
 * The runtime drill response is stubbed independently from the generation-time
 * fixture above and deliberately returns TWO candidates that coincide on
 * `currency`/`taxIncluded` (the structural guess) but differ on `voyageId`
 * (the declared join field) — a decoy row first, then the real match — so a
 * regression back to the structural guess would non-deterministically (or
 * always, since `.find()` returns the first match) graft the wrong
 * candidate's `weight` onto the primary item.
 */
function stubMultiCandidateFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (!url.includes("/orders/shipments/")) {
      return jsonResponse({
        orders: [
          {
            orderId: "ord-1",
            voyageId: "voy-1",
            priceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      });
    }
    return jsonResponse({
      candidates: [
        {
          trackingRef: "trk-decoy",
          voyageId: "voy-9",
          currency: "USD",
          taxIncluded: true,
          weight: 999,
        },
        { trackingRef: "trk-1", voyageId: "voy-1", currency: "USD", taxIncluded: true, weight: 12 },
      ],
    });
  });
  vi.stubGlobal("fetch", fn);
}

function buildEmission(): string {
  const actionSteps = buildActionSteps();
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
    SPEC
  );
}

describe("recon-generate fold-join honors declared joinFields over an unresolvable representative-item structural guess", () => {
  it("emits the declared voyageId join key in the fold-match block, never the structural currency/taxIncluded guess", () => {
    const body = buildEmission();

    const foldMatchBlock = body.slice(
      body.indexOf("const foldMatches"),
      body.indexOf("Object.assign")
    );

    expect(foldMatchBlock).toContain('m["voyageId"]');
    expect(foldMatchBlock).not.toContain('m["currency"]');
    expect(foldMatchBlock).not.toContain('m["taxIncluded"]');
    expect(body.match(/const foldMatches/g)?.length).toBe(1);
  });

  it("folds by the declared voyageId at runtime and never grafts the wrong candidate on when currency/taxIncluded coincide", async () => {
    const body = buildEmission();

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubMultiCandidateFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", track: "main" });

    expect(result.data).toEqual({
      orders: [
        {
          orderId: "ord-1",
          voyageId: "voy-1",
          priceSummary: { currency: "USD", taxIncluded: true },
          currency: "USD",
          taxIncluded: true,
          trackingRef: "trk-1",
          weight: 12,
        },
      ],
    });
  });
});
