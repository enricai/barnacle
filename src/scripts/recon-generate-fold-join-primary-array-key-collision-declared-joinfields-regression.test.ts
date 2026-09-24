import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A search → per-item drill-down where the drill endpoint's own response
 * array is read off a key IDENTICAL to the primary capture's own declared
 * `resultsPath` ("items" on both). Every drill candidate also carries a
 * coincidental nested `priceSummary: { currency, taxIncluded }` sub-object
 * that threads verbatim from the primary item, so a structural fallback
 * would reach for that pair. The flow declares `foldReturn.joinFields:
 * ["orderId"]`, a non-optional field present on every drill candidate, so
 * the generated fold-match `.find()` must key on the declared `orderId`
 * and never on the coincidental nested summary fields or the primary/drill
 * key-name collision.
 */
function buildActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"track":"main"}',
      responseBody: {
        items: [
          {
            orderId: "ord-1",
            priceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      },
      timestamp: "2024-07-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/pricing/ord-1/?currency=USD&taxIncluded=true",
      requestPostData: null,
      responseBody: {
        items: [
          { orderId: "decoy-1", priceSummary: { currency: "USD", taxIncluded: true }, weight: 999 },
          { orderId: "ord-1", priceSummary: { currency: "USD", taxIncluded: true }, weight: 12 },
        ],
      },
      timestamp: "2024-07-01T00:00:01Z",
    }),
  ];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/pricing/",
  resultsPath: "items",
  drillResultsPath: "items",
  joinFields: ["orderId"],
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
 * The runtime drill response deliberately returns TWO candidates that
 * coincide on `priceSummary.currency`/`priceSummary.taxIncluded` (the
 * structural guess) but differ on `orderId` (the declared join field) —
 * a decoy row first, then the real match — so a regression back to the
 * structural guess (or to the primary/drill array key collision resolving
 * the wrong array) would graft the wrong candidate's `weight` onto the
 * primary item.
 */
function stubMultiCandidateFetch(): void {
  const fn = vi.fn(async (url: string) => {
    if (!url.includes("/catalog/pricing/")) {
      return jsonResponse({
        items: [
          {
            orderId: "ord-1",
            priceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      });
    }
    return jsonResponse({
      items: [
        { orderId: "decoy-1", priceSummary: { currency: "USD", taxIncluded: true }, weight: 999 },
        { orderId: "ord-1", priceSummary: { currency: "USD", taxIncluded: true }, weight: 12 },
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

describe("recon-generate fold-join declared joinFields when primary resultsPath and drill array share the same key name", () => {
  it("emits the declared orderId join key in the fold-match block, never the coincidental nested priceSummary fields", () => {
    const body = buildEmission();

    const foldMatchBlock = body.slice(
      body.indexOf("const foldMatches"),
      body.indexOf("Object.assign")
    );

    expect(foldMatchBlock).toContain('m["orderId"]');
    expect(foldMatchBlock).not.toContain('m["currency"]');
    expect(foldMatchBlock).not.toContain('m["taxIncluded"]');
    expect(foldMatchBlock).not.toContain("priceSummary");
    expect(body.match(/const foldMatches/g)?.length).toBe(1);
  });

  it("folds by the declared orderId at runtime and grafts the row matching it, not the first structurally-coincidental candidate", async () => {
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
      items: [
        {
          orderId: "ord-1",
          priceSummary: { currency: "USD", taxIncluded: true },
          weight: 12,
        },
      ],
    });
  });
});
