import { describe, expect, it } from "vitest";
import { compileActionSteps, indexStateValues } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression for `keysCorrelate`'s substring-containment check
 * (`normalizeCorrelationToken` strips all non-alnum chars before comparing):
 * a nested response object keyed by a long, delimiter-joined dynamic string
 * (e.g. `stateroomTypes["DD-INSIDE;entityType=stateroom-type;destination=dcl"]`)
 * has no valid-identifier leaf segment, so `pathToVarName` falls back to the
 * nearest identifier ancestor — `stateroomTypes` — as the produced value's own
 * name. Normalized, `stateroomTypes` becomes `stateroomtypes`, which happens
 * to CONTAIN the short, unrelated target field `type` as a substring. Before
 * requiring a genuine name match, `keysCorrelate("stateroomTypes", "type")`
 * would wrongly return true and let a coincidentally-equal short scalar
 * splice into a target field it has nothing to do with.
 */
const CATALOG_SEARCH_URL = "https://api.example.com/catalog/search/";
const CATALOG_PRICING_URL = "https://api.example.com/catalog/pricing/";
const CATALOG_PRICE_HISTORY_URL = "https://api.example.com/catalog/price-history";

function buildCompoundMapKeyCaptures() {
  const search = buildCapture({
    url: CATALOG_SEARCH_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ sku: "sku-a" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const pricing = buildCapture({
    url: CATALOG_PRICING_URL,
    requestPostData: '{"sku":"sku-a"}',
    responseBody: {
      priceToken: "tok-a1",
      ship: {
        stateroomTypes: {
          "DD-INSIDE;entityType=stateroom-type;destination=dcl": 7,
        },
      },
      // A genuinely short (< MIN_STATE_VALUE_LENGTH) field reused under its
      // own, unambiguous name — must still thread despite the guard below.
      stockCount: 5,
      prices: [{ sku: "sku-a", amount: 19.99 }],
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const history = buildCapture({
    url: CATALOG_PRICE_HISTORY_URL,
    // "type" coincidentally equals the unrelated compound-keyed scalar (7)
    // above, but under a completely different, unrelated field name — never
    // a real thread. "stockCount" genuinely reuses the pricing response's
    // own field name and value.
    requestPostData: '{"priceToken":"tok-a1","type":7,"stockCount":5}',
    responseBody: {
      history: [{ sku: "sku-a", amount: 18.5, asOf: "2026-01-01" }],
    },
    timestamp: "2026-01-01T00:00:02Z",
  });
  return [search, pricing, history];
}

describe("keysCorrelate — a compound/delimiter-joined dynamic map key must not false-correlate with an unrelated short target field", () => {
  it("does not index the coincidentally-equal, compound-keyed short scalar as producible state", () => {
    const captures = buildCompoundMapKeyCaptures();
    const stateIndex = indexStateValues(captures);

    expect(stateIndex.has("7")).toBe(false);
  });

  it("still indexes the genuinely-threaded join field under the same name", () => {
    const captures = buildCompoundMapKeyCaptures();
    const stateIndex = indexStateValues(captures);

    expect(stateIndex.has("tok-a1")).toBe(true);
  });

  it("never emits a produces[] accessor for the compound-keyed coincidental scalar", () => {
    const captures = buildCompoundMapKeyCaptures();
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);

    const pricingStep = actionSteps.find((step) => step.capture.url === captures[1]!.url);
    const spliceForCompoundKey = pricingStep?.produces.find(
      (p) =>
        p.kind === "body" && p.path.at(-1) === "DD-INSIDE;entityType=stateroom-type;destination=dcl"
    );
    expect(spliceForCompoundKey).toBeUndefined();
  });

  it("still indexes and produces[] a genuinely same-named short field alongside the blocked compound-keyed one", () => {
    const captures = buildCompoundMapKeyCaptures();
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);

    expect(stateIndex.has("5")).toBe(true);

    const pricingStep = actionSteps.find((step) => step.capture.url === captures[1]!.url);
    const spliceForStockCount = pricingStep?.produces.find(
      (p) => p.kind === "body" && p.path.at(-1) === "stockCount"
    );
    expect(spliceForStockCount).toBeDefined();
  });
});
