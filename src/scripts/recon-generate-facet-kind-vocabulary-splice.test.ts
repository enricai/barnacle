import { describe, expect, it } from "vitest";
import { type NavigateToFacetBinding, renderGqlVariablesExpr } from "@/scripts/recon-generate";

const stepFacet = (field: string, value: string, kind: string): NavigateToFacetBinding => ({
  value,
  field,
  optional: false,
  origin: "step",
  literals: [value],
  kind,
});

describe("single-primary array splice with kind-suffixed elements", () => {
  it("renders each matched element with its kind suffix and casing, none literal", () => {
    const facets = [
      { ...stepFacet("destination", "Bahamas", "destination"), optional: true },
      { ...stepFacet("nights", "4", "nights"), optional: true },
    ];
    const expr = renderGqlVariablesExpr(
      { filters: ["BAHAMAS;filterType=destination", "4;filterType=night", "x;filterType=other"] },
      new Set(),
      new Set(),
      facets
    );
    expect(expr).toContain(
      "...(payload.destination ? [`${String(payload.destination).toUpperCase()};filterType=destination`] : [])"
    );
    expect(expr).toContain("...(payload.nights ? [`${payload.nights};filterType=night`] : [])");
    expect(expr).toContain('"x;filterType=other"');
    expect(expr).not.toContain('"BAHAMAS;filterType=destination"');
  });
});
