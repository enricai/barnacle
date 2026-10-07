import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { extractNavigateToFacetOrder, harvestPersonaBindings } from "@/scripts/recon-generate";

const EMPTY_VOCAB: ReconVocabulary = { subject: /(?!)/, exclusions: [], table: [] };

/**
 * Regression test for `extractNavigateToFacetOrder` discarding each
 * navigateTo+payloadField step's own `optional` flag. The bindings it
 * returns must carry `optional: boolean` reflecting that step's own
 * declaration, not the preceding hash-fragment step's.
 */
describe("extractNavigateToFacetOrder — optional flag threading", () => {
  it("reflects each step's own optional flag, not the preceding navigateTo step's", () => {
    const bindings = extractNavigateToFacetOrder([
      {
        step: "navigate to the widgets inventory category page",
        navigateTo: "https://inventory-catalog-regression-fixture.example.com/#/category/widgets",
        payloadField: "Category",
      },
      {
        step: "navigate to the warehouse inventory region page",
        navigateTo: "https://inventory-catalog-regression-fixture.example.com/#/region/east",
        payloadField: "Region",
        optional: true,
      },
      { step: "browse inventory search" },
    ]);

    expect(bindings).toEqual([
      { value: "widgets", field: "Category", optional: false },
      { value: "east", field: "Region", optional: true },
    ]);
  });
});

describe("hashless reset navigations between cumulative hash steps", () => {
  const steps = [
    { step: "go", navigateTo: "https://shop.example/#/s/a", payloadField: "Origin" },
    { step: "reset", navigateTo: "https://shop.example/" },
    { step: "go", navigateTo: "https://shop.example/#/s/a,b", payloadField: "Dest" },
    { step: "reset", navigateTo: "https://shop.example/" },
    { step: "go", navigateTo: "https://shop.example/#/s/a,b,c", payloadField: "Class" },
  ] as Parameters<typeof extractNavigateToFacetOrder>[0];

  it("yields one bare token per facet and matching persona bindings", () => {
    expect(extractNavigateToFacetOrder(steps).map((f) => f.value)).toEqual(["a", "b", "c"]);
    const bindings = harvestPersonaBindings(steps, EMPTY_VOCAB, {});
    expect([...bindings]).toEqual([
      ["a", "payload.Origin"],
      ["b", "payload.Dest"],
      ["c", "payload.Class"],
    ]);
  });
});
