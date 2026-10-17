import { describe, expect, it } from "vitest";
import {
  matchFacetRecurrence,
  type NavigateToFacetBinding,
  spliceFacetsIntoArrayVariable,
} from "@/scripts/recon-generate";

const ELEMENTS = ["2026-12;filterType=date", "NORTH;filterType=region"];

const clickFacet = (
  field: string,
  value: string,
  kind: string,
  kindHints: string[]
): NavigateToFacetBinding => ({
  value,
  field,
  optional: false,
  origin: "step",
  literals: [value],
  kind,
  kindHints,
});

const dateFacet = clickFacet("period", "2026-12", "period", ["Date"]);
const regionFacet = clickFacet("area", "NORTH", "area", ["REGION"]);

const copiesOf = (facet: NavigateToFacetBinding): Record<string, NavigateToFacetBinding> => ({
  original: facet,
  spread: { ...facet },
  alias: { ...facet, keyedByKind: true, valueMap: new Map([["x", facet.value]]) },
  optional: { ...facet, optional: true },
});

const bind = (facet: NavigateToFacetBinding, element: string): string | undefined =>
  matchFacetRecurrence(element, [facet], { allowDelimiterSuffix: true })?.field;

describe("facet kind hints survive every binding copy", () => {
  for (const [name, facet, own, other] of [
    ["date", dateFacet, ELEMENTS[0]!, ELEMENTS[1]!],
    ["region", regionFacet, ELEMENTS[1]!, ELEMENTS[0]!],
  ] as const) {
    for (const [copyName, copy] of Object.entries(copiesOf(facet))) {
      it(`${name} facet binds its own kind after ${copyName} copy`, () => {
        expect(bind(copy, own)).toBe(facet.field);
        expect(
          bind(
            copy,
            own.toUpperCase().replace(/=.*/, (m) => m.toLowerCase())
          )
        ).toBe(facet.field);
        expect(bind(copy, other)).toBeUndefined();
      });
    }
  }

  it("binds a matched copy produced by matchFacetRecurrence itself", () => {
    const matched = matchFacetRecurrence("2026-12;filterType=date", [dateFacet], {
      allowDelimiterSuffix: true,
    });
    expect(matched).toBeDefined();
    expect(bind({ ...matched!, value: "2026-12" }, ELEMENTS[0]!)).toBe("period");
  });

  it("picks the element of each facet's kind when both copies compete", () => {
    const facets = [
      { ...dateFacet, optional: true },
      { ...regionFacet, keyedByKind: true },
    ];
    expect(matchFacetRecurrence(ELEMENTS[0]!, facets, { allowDelimiterSuffix: true })?.field).toBe(
      "period"
    );
    expect(matchFacetRecurrence(ELEMENTS[1]!, facets, { allowDelimiterSuffix: true })?.field).toBe(
      "area"
    );
  });

  it("does not bind a facet whose hints name another kind when the kind is claimed", () => {
    const wrong = clickFacet("other", "2026-12", "other", ["theme"]);
    const matched = matchFacetRecurrence(ELEMENTS[0]!, [wrong, { ...dateFacet }], {
      allowDelimiterSuffix: true,
    });
    expect(matched?.field).toBe("period");
  });

  it("renders copied facets into the array variable", () => {
    const rendered = spliceFacetsIntoArrayVariable(ELEMENTS, [
      { ...dateFacet },
      { ...regionFacet, optional: true },
    ]);
    expect(rendered).toContain("payload.period");
    expect(rendered).toContain("...(payload.area ? [");
  });
});
