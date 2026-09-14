import { describe, expect, it } from "vitest";
import { compileActionSteps, indexStateValues } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the report's actual functional-correctness defect: a dependent
 * drill-down chain hop's response carries, alongside its genuine join value
 * (`priceToken`), an UNRELATED deeply-nested scalar (a UI sort-order
 * integer, `sortOrder`) that merely happens to numerically coincide with a
 * later, unrelated request field's true value (`page`). Before the fix,
 * `collectDependentDrillDownChainValues` proved threading by bare value
 * equality alone, so `sortOrder`'s value was force-included into the state
 * index despite being far under `MIN_STATE_VALUE_LENGTH`, and
 * `compileActionSteps` spliced it into `page` — a field it has nothing to do
 * with. The fix requires the SAME field name on both sides (or a name-free
 * URL path segment / array index) before a short value can bypass the
 * length floor.
 */
const CATALOG_SEARCH_URL = "https://api.example.com/catalog/search/";
const CATALOG_PRICING_URL = "https://api.example.com/catalog/pricing/";
const CATALOG_PRICE_HISTORY_URL = "https://api.example.com/catalog/price-history";

function buildCoincidentalScalarChainCaptures() {
  const search = buildCapture({
    url: CATALOG_SEARCH_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const pricing = buildCapture({
    url: CATALOG_PRICING_URL,
    requestPostData: '{"sku":"sku-a"}',
    responseBody: {
      priceToken: "tok-a1",
      ship: { stateroomTypes: { inside: { displayOrder: { sortOrder: 7 } } } },
      prices: [{ sku: "sku-a", amount: 19.99 }],
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const history = buildCapture({
    url: CATALOG_PRICE_HISTORY_URL,
    // "page" coincidentally equals the unrelated sortOrder scalar (7) above,
    // but under a completely different field name — never a real thread.
    requestPostData: '{"priceToken":"tok-a1","page":7}',
    responseBody: {
      history: [{ sku: "sku-a", amount: 18.5, asOf: "2026-01-01" }],
    },
    timestamp: "2026-01-01T00:00:02Z",
  });
  return [search, pricing, history];
}

describe("collectDependentDrillDownChainValues — coincidental value equality across unrelated field names is not chain-proven threading", () => {
  it("does not index the coincidentally-equal, name-uncorrelated short scalar as producible state", () => {
    const captures = buildCoincidentalScalarChainCaptures();
    const stateIndex = indexStateValues(captures);

    expect(stateIndex.has("7")).toBe(false);
  });

  it("still indexes the genuinely-threaded join field under the same name", () => {
    const captures = buildCoincidentalScalarChainCaptures();
    const stateIndex = indexStateValues(captures);

    expect(stateIndex.has("tok-a1")).toBe(true);
  });

  it("never emits a produces[] accessor for the coincidentally-equal scalar", () => {
    const captures = buildCoincidentalScalarChainCaptures();
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);

    const pricingStep = actionSteps.find((step) => step.capture.url === captures[1]!.url);
    const spliceForSortOrder = pricingStep?.produces.find(
      (p) => p.kind === "body" && p.path.at(-1) === "sortOrder"
    );
    expect(spliceForSortOrder).toBeUndefined();
  });

  it("does not exempt a NAMED source field from name-correlation just because it coincidentally lands inside a later-side array element", () => {
    // The array-index exemption exists so a name-free source (an array
    // element with no field name of its own) can still thread into a
    // name-free destination. It must not let a genuinely NAMED source field
    // (`sortOrder`) dodge correlation merely because the coincidentally-equal
    // value happens to sit inside a later request's array (`tokens: [7]`).
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
        ship: { stateroomTypes: { inside: { displayOrder: { sortOrder: 7 } } } },
      },
      timestamp: "2026-01-01T00:00:01Z",
    });
    const history = buildCapture({
      url: CATALOG_PRICE_HISTORY_URL,
      requestPostData: '{"priceToken":"tok-a1","tokens":[7]}',
      responseBody: { history: [{ sku: "sku-a", amount: 18.5 }] },
      timestamp: "2026-01-01T00:00:02Z",
    });
    const stateIndex = indexStateValues([search, pricing, history]);

    expect(stateIndex.has("7")).toBe(false);
  });
});
