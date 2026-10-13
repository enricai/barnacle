import { describe, expect, it } from "vitest";
import { extractNavigateToFacetOrder, harvestPersonaBindings } from "@/scripts/recon-generate";

const VOCAB = { exclusions: [] } as never;

describe("click-step facet collection", () => {
  const flow = [
    { step: "go", navigateTo: "https://example.com/#/jobs/category-gadgets", payloadField: "Kind" },
    { step: "select the 'Widgets' category option", payloadField: "Category" },
    { step: "click the 'Apply' button", payloadField: "Nothing", payloadFieldNone: true },
    { step: "click the button", payloadField: "NoQuote" },
  ];

  it("collects click facets in flow order with step origin", () => {
    expect(extractNavigateToFacetOrder(flow, {})).toEqual([
      { value: "category-gadgets", field: "Kind", optional: false },
      { value: "Widgets", field: "Category", optional: false, origin: "step" },
    ]);
  });

  it("harvestPersonaBindings reads the same walk", () => {
    const b = harvestPersonaBindings(flow as never, VOCAB, {});
    expect(b.get("Widgets")).toBe("payload.Category");
    expect(b.has("Apply")).toBe(false);
  });
});
