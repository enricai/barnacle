import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A per-item drill loop (TWO distinct primary items, each driving its OWN
 * 2-hop item-scoped chain: a session mint parameterized on that item's
 * `productId` — `/catalog/session/?productId=p1` vs `?productId=p2` — whose
 * response's `sessionToken` threads onward, followed by a terminal drill
 * call whose own request threads NO item-derived value at all). Because the
 * terminal's own request threads nothing from the item, the structural
 * heuristic's request-threading scan can only resolve a `drillStepIndex` at
 * the entry (session) hop, while `buildFoldPlanFromSpec`'s endpointPattern
 * match resolves the spec plan directly at the terminal — the same
 * entry-vs-terminal `drillStepIndex` divergence `foldTargetDrillIdentity`
 * exists to bridge, now exercised through the item-scoped/per-item-loop path
 * (referencesItemVar/hasItemScopedFetch) rather than a single shared fold.
 * Each item's terminal response returns multiple candidate rows sharing an
 * identical nested `priceSummary: { currency, taxIncluded }` sub-object — a
 * decoy shaped exactly like the generic structural fallback a `.find()`
 * would reach for once no request-threaded field is present on the drill
 * response — while differing on the declared, request-unthreaded
 * `offerToken` join field. Locks that the emitted `.find()` always keys on
 * the declared `offerToken` field and never the nested `priceSummary`
 * fallback, for this item-scoped per-item chain.
 */
function buildItemScopedTwoItemActionSteps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        results: [
          {
            productId: "p1",
            offerToken: "offer-p1",
            priceSummary: { currency: "USD", taxIncluded: true },
          },
          {
            productId: "p2",
            offerToken: "offer-p2",
            priceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      },
      timestamp: "2024-07-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: "https://api.example.com/catalog/session/?productId=p1",
      requestPostData: '{"productId":"p1"}',
      responseBody: { sessionToken: "sess-p1" },
      timestamp: "2024-07-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: "https://api.example.com/catalog/availability/",
      requestPostData: '{"sessionToken":"sess-p1"}',
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
      timestamp: "2024-07-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: "https://api.example.com/catalog/session/?productId=p2",
      requestPostData: '{"productId":"p2"}',
      responseBody: { sessionToken: "sess-p2" },
      timestamp: "2024-07-01T00:00:03Z",
    }),
    buildStep("r4", {
      url: "https://api.example.com/catalog/availability/",
      requestPostData: '{"sessionToken":"sess-p2"}',
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
      timestamp: "2024-07-01T00:00:04Z",
    }),
  ];
}

const ITEM_SCOPED_TWO_ITEM_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/availability/",
  resultsPath: "results",
  drillResultsPath: "availability",
  joinFields: ["offerToken"],
};

describe("recon-generate foldReturn declared joinFields — item-scoped per-item drill chain with nested price-summary-shaped fallback field", () => {
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
