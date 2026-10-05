import { describe, expect, it } from "vitest";
import { extractNavigateToFacetOrder } from "@/scripts/recon-generate";

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
