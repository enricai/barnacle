import { describe, expect, it } from "vitest";
import { spliceFacetsIntoArrayVariable } from "@/scripts/recon-generate";

const facets = [{ field: "Category", value: "Widgets", optional: false }] as never;

describe("facet recurrence casing", () => {
  it("re-applies upper casing and keeps the suffix", () => {
    expect(spliceFacetsIntoArrayVariable(["WIDGETS;filterType=category"], facets)).toBe(
      "[`${String(payload.Category).toUpperCase()};filterType=category`]"
    );
  });
  it("re-applies lower casing", () => {
    expect(spliceFacetsIntoArrayVariable(["widgets;filterId=x"], facets)).toBe(
      "[`${String(payload.Category).toLowerCase()};filterId=x`]"
    );
  });
  it("leaves exact case untouched and rejects alnum continuation", () => {
    expect(spliceFacetsIntoArrayVariable(["Widgets;a=b"], facets)).toBe(
      "[`${payload.Category};a=b`]"
    );
    expect(spliceFacetsIntoArrayVariable(["WIDGETSX"], facets)).toBeNull();
  });
});
