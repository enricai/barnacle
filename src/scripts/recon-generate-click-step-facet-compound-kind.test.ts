import { describe, expect, it } from "vitest";
import {
  extractNavigateToFacetOrder,
  type NavigateToFacetBinding,
  resolveRecurringNavigateToFacets,
} from "@/scripts/recon-generate";

const actionsFor = (filters: string[]): Parameters<typeof resolveRecurringNavigateToFacets>[1] =>
  [
    {
      capture: {
        url: "https://shop.example.com/quote/",
        requestPostData: JSON.stringify({ filters }),
        requestHeaders: {},
      },
    },
  ] as unknown as Parameters<typeof resolveRecurringNavigateToFacets>[1];

const clickFacet = (field: string, value: string): NavigateToFacetBinding => ({
  value,
  field,
  optional: false,
  origin: "step",
  kind: field,
  literals: [value],
});

describe("resolveRecurringNavigateToFacets — click-step facet against a compound element kind", () => {
  it("owns an element whose compound kind contains the facet's own kind word", () => {
    const resolved = resolveRecurringNavigateToFacets(
      [clickFacet("port", "Harbor")],
      actionsFor(["HBR;filterType=portOfCall"])
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ field: "port", value: "HBR", keyedByKind: true });
  });

  it("keeps a plain-kind element working alongside compound kinds", () => {
    const resolved = resolveRecurringNavigateToFacets(
      [clickFacet("destination", "Western Caribbean")],
      actionsFor(["CARIB;filterType=destination"])
    );
    expect(resolved[0]).toMatchObject({ field: "destination", value: "CARIB", keyedByKind: true });
  });
});

describe("extractNavigateToFacetOrder — kind named by the prose ahead of the quoted value", () => {
  const resolveStep = (step: string, field: string, element: string): unknown =>
    resolveRecurringNavigateToFacets(
      extractNavigateToFacetOrder([{ step, payloadField: field }]),
      actionsFor([element])
    );

  it("owns the element of a kind a container noun names", () => {
    expect(
      resolveStep("In the harbor dropdown select 'Northern Bay'", "trip", "NBAY;filterType=harbor")
    ).toMatchObject([{ field: "trip", value: "NBAY", keyedByKind: true }]);
  });

  it("owns the element of a kind written directly before the value", () => {
    expect(
      resolveStep("Select the harbor 'Northern Bay'", "trip", "NBAY;filterType=harbor")
    ).toMatchObject([{ field: "trip", value: "NBAY", keyedByKind: true }]);
  });

  it("leaves an element of an unnamed kind unowned", () => {
    expect(
      resolveStep("In the harbor dropdown select 'Northern Bay'", "trip", "NBAY;filterType=berth")
    ).toEqual([]);
  });
});
