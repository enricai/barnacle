import { describe, expect, it } from "vitest";
import {
  extractNavigateToFacetOrder,
  harvestPersonaBindings,
  resolveRecurringNavigateToFacets,
} from "@/scripts/recon-generate";

const VOCAB = { exclusions: [] } as never;

const flow = [
  { step: "go", navigateTo: "https://example.com/#/jobs/category-gadgets", payloadField: "Kind" },
  { step: "select the 'Widgets' category option", payloadField: "Category" },
  { step: "click the 'Apply' button", payloadField: "Nothing", payloadFieldNone: true },
  { step: "click the button", payloadField: "NoQuote" },
];

describe("click-step facet collection", () => {
  it("collects click facets in flow order with step origin", () => {
    expect(extractNavigateToFacetOrder(flow, {})).toEqual([
      {
        value: "category-gadgets",
        field: "Kind",
        optional: false,
        literals: ["category-gadgets"],
        kind: "kind",
      },
      {
        value: "Widgets",
        field: "Category",
        optional: false,
        origin: "step",
        literals: ["Widgets"],
        kind: "category",
      },
    ]);
  });

  it("harvestPersonaBindings reads the same walk", () => {
    const b = harvestPersonaBindings(flow as never, VOCAB, {});
    expect(b.get("Widgets")).toBe("payload.Category");
    expect(b.has("Apply")).toBe(false);
  });
});

describe("step-origin facets in resolveRecurringNavigateToFacets", () => {
  const action = {
    capture: {
      timestamp: "2026-01-01T00:00:00.000Z",
      phase: "search",
      method: "POST",
      url: "https://shop.example.com/api/search",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ cat: "Widgets" }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: {},
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    },
    varName: "r0",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };

  it("keeps a step facet whose literal recurs in a request", () => {
    const declared = extractNavigateToFacetOrder(flow, {});
    const resolved = resolveRecurringNavigateToFacets(declared, [action as never]);
    expect(resolved.map((f) => f.field)).toContain("Category");
  });

  it("drops an unreachable step facet and never positionally correlates it", () => {
    const miss = { ...action, capture: { ...action.capture, requestPostData: "{}" } };
    const declared = extractNavigateToFacetOrder(flow, {});
    const resolved = resolveRecurringNavigateToFacets(declared, [miss as never]);
    expect(resolved.map((f) => f.field)).not.toContain("Category");
  });
});

describe("facet literal set and kind", () => {
  it("exposes literals and kind for click-step facets", () => {
    const bindings = extractNavigateToFacetOrder(
      [
        { step: "click the 'Bahamas' destination option", payloadField: "destination" },
        { step: "click the '4' nights option", payloadField: "tripLength" },
      ],
      {}
    );
    expect(bindings.map((b) => [b.value, b.literals, b.kind])).toEqual([
      ["Bahamas", ["Bahamas"], "destination"],
      ["4", ["4"], "trip length"],
    ]);
  });
});
