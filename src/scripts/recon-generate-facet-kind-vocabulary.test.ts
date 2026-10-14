import { describe, expect, it } from "vitest";
import {
  matchFacetRecurrence,
  type NavigateToFacetBinding,
  resolveRecurringNavigateToFacets,
} from "@/scripts/recon-generate";

type Actions = Parameters<typeof resolveRecurringNavigateToFacets>[1];

const stepFacet = (field: string, value: string, kind: string): NavigateToFacetBinding => ({
  value,
  field,
  optional: false,
  origin: "step",
  literals: [value],
  kind,
});

const hashFacet = (field: string, value: string, kind: string): NavigateToFacetBinding => ({
  value,
  field,
  optional: false,
  origin: "navigateTo",
  literals: [value],
  kind,
});

const actionWith = (filters: string[]): Actions[number] =>
  ({
    capture: {
      url: "https://example.com/api",
      requestPostData: JSON.stringify({ filters }),
      requestHeaders: {},
    },
  }) as unknown as Actions[number];

const CODE_ELEMENTS = [
  "2026-12;filterType=date",
  "BAHAMAS;filterType=destination",
  "MERRY;filterType=theme",
  "4;filterType=night",
];

describe("facet matching by literal set and element kind", () => {
  const facets = [
    stepFacet("destination", "Bahamas", "destination"),
    stepFacet("nights", "4", "nights"),
  ];

  it("binds a keyed facet only to elements of its own kind, case-insensitively", () => {
    expect(
      matchFacetRecurrence("BAHAMAS;filterType=destination", facets, { allowDelimiterSuffix: true })
        ?.field
    ).toBe("destination");
    expect(
      matchFacetRecurrence("4;filterType=night", facets, { allowDelimiterSuffix: true })?.field
    ).toBe("nights");
  });

  it("does not let a short keyed literal over-match another kind's element", () => {
    expect(
      matchFacetRecurrence("bahamas-trips;filterId=urlFriendlyId", facets, {
        allowDelimiterSuffix: true,
      })
    ).toBeUndefined();
  });

  it("still binds an unkeyed hash facet's literal element of any suffix kind", () => {
    const hash = [hashFacet("destination", "bahamas-trips", "destination")];
    expect(
      matchFacetRecurrence("bahamas-trips;filterId=urlFriendlyId", hash, {
        allowDelimiterSuffix: true,
      })?.field
    ).toBe("destination");
  });
});

describe("resolveRecurringNavigateToFacets code-vocabulary literal", () => {
  it("derives a never-recurring hash facet's literal from the kind-tagged element", () => {
    const resolved = resolveRecurringNavigateToFacets(
      [hashFacet("theme", "holiday-fun", "theme"), hashFacet("ship", "wonder-ship", "ship")],
      [actionWith(["x"]), actionWith([...CODE_ELEMENTS, "WW;filterType=ship"])]
    );
    expect(resolved.slice(2).map(({ field, value }) => [field, value])).toEqual([
      ["theme", "MERRY"],
      ["ship", "WW"],
    ]);
  });
});

describe("resolveRecurringNavigateToFacets alias for every declared facet", () => {
  it("adds the code-vocabulary literal for a hash facet whose slug also recurs", () => {
    const resolved = resolveRecurringNavigateToFacets(
      [hashFacet("ship", "disney-wish", "ship"), hashFacet("date", "december-2026", "date")],
      [
        actionWith([
          "disney-wish;filterId=urlFriendlyId",
          "WW;filterType=ship",
          "december-2026;filterId=urlFriendlyId",
          "2026-12;filterType=date",
        ]),
      ]
    );
    expect(resolved.map(({ field, value }) => [field, value])).toEqual([
      ["ship", "disney-wish"],
      ["date", "december-2026"],
      ["ship", "WW"],
      ["date", "2026-12"],
    ]);
  });

  it("threads a click-step facet whose quoted literal never recurs by its kind suffix", () => {
    const resolved = resolveRecurringNavigateToFacets(
      [stepFacet("destination", "Bahamas", "destination"), stepFacet("nights", "4", "nights")],
      [actionWith(["BS;filterType=destination", "4;filterType=night"])]
    );
    expect(resolved.map(({ field, value }) => [field, value])).toEqual([
      ["nights", "4"],
      ["destination", "BS"],
    ]);
  });

  it("binds a field whose name qualifies the element kind to that element", () => {
    const resolved = resolveRecurringNavigateToFacets(
      [hashFacet("sailDate", "december-2026", "sail date")],
      [actionWith(["2026-12;filterType=date"])]
    );
    expect(resolved.map(({ field, value }) => [field, value])).toEqual([
      ["sailDate", "december-2026"],
      ["sailDate", "2026-12"],
    ]);
  });
});
