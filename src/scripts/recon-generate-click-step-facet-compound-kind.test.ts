import { describe, expect, it } from "vitest";
import {
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
