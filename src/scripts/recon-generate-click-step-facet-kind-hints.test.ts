import { describe, expect, it } from "vitest";
import { extractNavigateToFacetOrder } from "@/scripts/recon-generate";

describe("click-step facet kind evidence", () => {
  it("derives kind hints from the step prose and keeps the facets", () => {
    const facets = extractNavigateToFacetOrder(
      [
        { step: "select the 'Lisbon' city option", payloadField: "destination" },
        { step: "select the '3' nights option", payloadField: "stayLength" },
      ],
      {}
    );
    expect(facets.map((facet) => facet.value)).toEqual(["Lisbon", "3"]);
    expect(facets.map((facet) => facet.literals)).toEqual([["Lisbon"], ["3"]]);
  });
});
