import { describe, expect, it } from "vitest";
import {
  extractNavigateToFacetOrder,
  matchFacetRecurrence,
  resolveRecurringNavigateToFacets,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const poolOf = (filters: string[]): Parameters<typeof resolveRecurringNavigateToFacets>[1] => [
  {
    capture: buildCapture({
      url: "https://shop.example.com/search",
      requestPostData: JSON.stringify({ filters }),
      responseBody: {},
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  },
];

describe("click-step facet resolution contract", () => {
  it("binds a plural facet noun to the singular element kind when the literal is absent", () => {
    const facets = extractNavigateToFacetOrder(
      [{ step: "select the '4' nights option", payloadField: "stayLength" }],
      {}
    );
    const resolved = resolveRecurringNavigateToFacets(facets, poolOf(["4;filterType=night"]));
    expect(
      matchFacetRecurrence("4;filterType=night", resolved, { allowDelimiterSuffix: true })?.field
    ).toBe("stayLength");
  });

  it("keeps an unreachable step literal out of the resolved set while its kind still governs elements", () => {
    const facets = extractNavigateToFacetOrder(
      [{ step: "select the 'Lisbon' city option", payloadField: "destination" }],
      {}
    );
    const resolved = resolveRecurringNavigateToFacets(facets, poolOf(["PRT;filterType=city"]));
    expect(resolved.map((f) => f.value)).not.toContain("Lisbon");
    expect(resolved.map((f) => [f.field, f.value])).toEqual([["destination", "PRT"]]);
  });

  it("reports a step facet whose literal and kind appear nowhere as governing nothing", () => {
    const facets = extractNavigateToFacetOrder(
      [{ step: "select the 'Lisbon' city option", payloadField: "destination" }],
      {}
    );
    const resolved = resolveRecurringNavigateToFacets(facets, poolOf(["x;filterType=theme"]));
    expect(resolved.filter((f) => f.field === "destination")).toEqual([]);
  });

  it("gives two facets of one kind each their own alias", () => {
    const facets = extractNavigateToFacetOrder(
      [
        { step: "select the 'Lisbon' city option", payloadField: "destination" },
        { step: "select the 'Porto' city option", payloadField: "destination" },
      ],
      {}
    );
    const resolved = resolveRecurringNavigateToFacets(
      facets,
      poolOf(["LIS;filterType=city", "PRT;filterType=city"])
    );
    expect(
      resolved
        .filter((f) => f.keyedByKind === true)
        .map((f) => f.value)
        .sort()
    ).toEqual(["LIS", "PRT"]);
  });
});
