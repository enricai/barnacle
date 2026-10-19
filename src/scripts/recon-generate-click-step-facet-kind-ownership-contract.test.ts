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
      url: "https://store.example.com/catalog",
      requestPostData: JSON.stringify({ filters }),
      responseBody: {},
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  },
];

describe("facet-to-kind ownership by element kind suffix", () => {
  const facets = extractNavigateToFacetOrder(
    [
      { step: "select the '2' qty option", payloadField: "quantity" },
      { step: "select the 'north' area option", payloadField: "region" },
    ],
    {}
  );
  const resolved = resolveRecurringNavigateToFacets(
    facets,
    poolOf(["2;filterType=qty", "5;filterType=qty", "NRT;filterType=area", "SUD;filterType=area"])
  );
  const owner = (element: string): string | undefined =>
    matchFacetRecurrence(element, resolved, { allowDelimiterSuffix: true })?.field;

  it("binds each element to the facet whose prose names its kind, despite neutral field wording", () => {
    expect(owner("2;filterType=qty")).toBe("quantity");
    expect(owner("5;filterType=qty")).toBe("quantity");
    expect(owner("NRT;filterType=area")).toBe("region");
    expect(owner("SUD;filterType=area")).toBe("region");
  });

  it("never lets two facets of different kinds claim the same element", () => {
    const fields = resolved.map((f) => f.field);
    expect(new Set(fields)).toEqual(new Set(["quantity", "region"]));
    const claimed = resolved.map((f) => `${f.field}:${f.value}`);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(resolved.filter((f) => f.field === "quantity").map((f) => f.value)).not.toContain("NRT");
    expect(resolved.filter((f) => f.field === "region").map((f) => f.value)).not.toContain("5");
  });

  it("does not claim an element whose kind names no facet", () => {
    expect(owner("BLU;filterType=colour")).toBeUndefined();
  });

  it("claims nothing for a facet whose kind appears in no element", () => {
    const lone = extractNavigateToFacetOrder(
      [{ step: "select the 'north' area option", payloadField: "region" }],
      {}
    );
    const out = resolveRecurringNavigateToFacets(lone, poolOf(["BLU;filterType=colour"]));
    expect(out.filter((f) => f.field === "region")).toEqual([]);
  });

  it("matches a plural facet noun to a singular element kind", () => {
    const plural = extractNavigateToFacetOrder(
      [{ step: "select the '2' quantities option", payloadField: "amounts" }],
      {}
    );
    const out = resolveRecurringNavigateToFacets(plural, poolOf(["2;filterType=quantity"]));
    expect(out.map((f) => f.field)).toContain("amounts");
  });
});

describe("date-part facet ownership of the umbrella date kind", () => {
  it("binds every element of kind `date` to a month-worded facet, case-insensitively", () => {
    const facets = extractNavigateToFacetOrder(
      [{ step: "select the '2026-12' month option", payloadField: "departureMonth" }],
      {}
    );
    const resolved = resolveRecurringNavigateToFacets(
      facets,
      poolOf(["2026-12;filterType=date", "2027-01;filterType=Date"])
    );
    const owner = (element: string): string | undefined =>
      matchFacetRecurrence(element, resolved, { allowDelimiterSuffix: true })?.field;
    expect(owner("2027-01;filterType=Date")).toBe("departureMonth");
    expect(owner("2027-01;filterType=date")).toBe("departureMonth");
  });
});
