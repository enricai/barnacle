import { describe, expect, it } from "vitest";
import { extractNavigateToFacetOrder } from "@/scripts/recon-generate";

/**
 * Pins the producer-layer contract for `NavigateToFacetBinding.optional`:
 * a navigateTo step's own `optional` declaration must survive onto its
 * binding untouched, both when the step opts in and when it doesn't.
 */
describe("extractNavigateToFacetOrder — binding.optional reflects the step's own declaration", () => {
  it("sets optional: true for a step declared optional:true", () => {
    const bindings = extractNavigateToFacetOrder([
      {
        step: "navigate to the catalog brand page",
        navigateTo: "https://catalog-fixture.example.com/#/brand/acme",
        payloadField: "Brand",
        optional: true,
      },
    ]);

    expect(bindings).toEqual([{ value: "acme", field: "Brand", optional: true }]);
  });

  it("sets optional: false for a structurally identical step without optional:true", () => {
    const bindings = extractNavigateToFacetOrder([
      {
        step: "navigate to the catalog brand page",
        navigateTo: "https://catalog-fixture.example.com/#/brand/acme",
        payloadField: "Brand",
      },
    ]);

    expect(bindings).toEqual([{ value: "acme", field: "Brand", optional: false }]);
  });

  it("sets optional: false for a step explicitly declared optional:false", () => {
    const bindings = extractNavigateToFacetOrder([
      {
        step: "navigate to the catalog brand page",
        navigateTo: "https://catalog-fixture.example.com/#/brand/acme",
        payloadField: "Brand",
        optional: false,
      },
    ]);

    expect(bindings).toEqual([{ value: "acme", field: "Brand", optional: false }]);
  });
});
