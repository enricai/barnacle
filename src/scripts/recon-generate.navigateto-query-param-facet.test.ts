import { describe, expect, it } from "vitest";
import { extractNavigateToFacetOrder } from "@/scripts/recon-generate";

const B = "https://shop.example.com/search";

describe("extractNavigateToFacetOrder — hashless query-param facets", () => {
  it("takes the one changed query param as the facet value", () => {
    const out = extractNavigateToFacetOrder([
      { step: "pick currency", navigateTo: `${B}?cur=GBP`, payloadField: "currency" },
      { step: "pick size", navigateTo: `${B}?cur=GBP&n=3`, payloadField: "size" },
    ]);
    expect(out.map((f) => [f.field, f.value])).toEqual([
      ["currency", "GBP"],
      ["size", "3"],
    ]);
  });

  it("leaves an ambiguous multi-param change unwired", () => {
    const out = extractNavigateToFacetOrder([
      { step: "x", navigateTo: `${B}?cur=GBP&n=3`, payloadField: "currency" },
    ]);
    expect(out[0]!.value).toBe("");
  });
});
