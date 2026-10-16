import { describe, expect, it } from "vitest";
import {
  extractNavigateToFacetOrder,
  resolveRecurringNavigateToFacets,
} from "@/scripts/recon-generate";

type Actions = Parameters<typeof resolveRecurringNavigateToFacets>[1];

const actionWith = (filters: string[]): Actions[number] =>
  ({
    capture: {
      url: "https://example.com/api",
      requestPostData: JSON.stringify({ filters }),
      requestHeaders: {},
    },
  }) as unknown as Actions[number];

describe("click-step facet kind evidence", () => {
  const facets = extractNavigateToFacetOrder(
    [
      { step: "select the 'Lisbon' city option", payloadField: "destination" },
      { step: "select the '3' nights option", payloadField: "stayLength" },
    ],
    {}
  );

  it("keeps both facets with their literals", () => {
    expect(facets.map((facet) => facet.literals)).toEqual([["Lisbon"], ["3"]]);
  });

  it("owns the element of the kind its step names, not the field name", () => {
    const resolved = resolveRecurringNavigateToFacets(facets, [
      actionWith(["LIS;filterType=city", "7;filterType=nights", "x;filterType=theme"]),
    ]);
    expect(resolved.map(({ field, value }) => [field, value])).toEqual([
      ["destination", "LIS"],
      ["stayLength", "7"],
    ]);
  });
});
