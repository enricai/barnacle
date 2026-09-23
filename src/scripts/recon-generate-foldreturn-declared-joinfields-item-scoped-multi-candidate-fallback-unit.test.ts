import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A per-item drill loop (TWO distinct primary items, each driving its OWN
 * parameterized drill request — `/catalog/availability/p1` for `productId:
 * "p1"`, `/catalog/availability/p2` for `productId: "p2"`, the request
 * genuinely varying per item) rather than one item captured twice. Each
 * item's drill response returns multiple candidate rows sharing an
 * identical nested `priceSummary: { currency, taxIncluded }` sub-object — a
 * decoy shaped exactly like the generic structural fallback a `.find()`
 * would reach for once no request-threaded field is present on the drill
 * response — while differing on the declared, request-unthreaded
 * `offerToken` join field. Locks that the emitted `.find()` always keys on
 * the declared `offerToken` field and never the nested `priceSummary`
 * fallback, for this item-scoped per-item loop.
 */
function buildItemScopedTwoItemActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        results: [
          { productId: "p1", offerToken: "offer-p1" },
          { productId: "p2", offerToken: "offer-p2" },
        ],
      },
      timestamp: "2024-07-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/availability/?productId=p1",
      requestPostData: '{"productId":"p1"}',
      responseBody: {
        availability: [
          {
            offerToken: "decoy-1",
            priceSummary: { currency: "USD", taxIncluded: true },
          },
          {
            offerToken: "offer-p1",
            priceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      },
      timestamp: "2024-07-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/availability/?productId=p2",
      requestPostData: '{"productId":"p2"}',
      responseBody: {
        availability: [
          {
            offerToken: "decoy-2",
            priceSummary: { currency: "USD", taxIncluded: true },
          },
          {
            offerToken: "offer-p2",
            priceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      },
      timestamp: "2024-07-01T00:00:02Z",
    }),
  ];
}

const ITEM_SCOPED_TWO_ITEM_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/availability/",
  resultsPath: "results",
  drillResultsPath: "availability",
  joinFields: ["offerToken"],
};

describe("recon-generate foldReturn declared joinFields — item-scoped per-item drill loop with nested price-summary-shaped fallback field", () => {
  it("emits the declared joinFields accessor in the foldMatch .find() condition and never the nested summary fallback", () => {
    const actionSteps = buildItemScopedTwoItemActionSteps();
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
      ITEM_SCOPED_TWO_ITEM_SPEC
    );

    const findLineMatch = body.match(
      /const foldMatch\d* = foldMatches\d*\.length.*\.find\(\(m\) => [^;]+;/
    );
    expect(findLineMatch).not.toBeNull();
    const findLine = findLineMatch![0];

    expect(findLine).toContain('m["offerToken"]');
    expect(findLine).not.toContain('m["currency"]');
    expect(findLine).not.toContain('m["taxIncluded"]');
    expect(findLine).not.toContain("priceSummary");
  });
});
