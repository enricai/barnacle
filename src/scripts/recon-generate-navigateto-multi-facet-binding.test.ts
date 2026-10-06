import { describe, expect, it } from "vitest";
import { extractNavigateToFacetOrder } from "@/scripts/recon-generate";

const BASE = "https://shop.example.com/#/catalog";
const FACETS = ["brand", "color", "size", "material", "season", "origin", "style"];

function flowFor(hashes: string[]): Parameters<typeof extractNavigateToFacetOrder>[0] {
  return hashes.map((hash, i) => ({
    step: `open facet ${i}`,
    navigateTo: `${BASE}${hash}`,
    payloadField: FACETS[i]!,
  }));
}

describe("extractNavigateToFacetOrder — every declared facet is bound", () => {
  it.each([
    ["comma", ["/acme", ",red", ",xl", ",cotton", ",spring", ",paris", ",modern"]],
    [
      "key=value",
      ["/b=acme", "&c=red", "&s=xl", "&m=cotton", "&se=spring", "&o=paris", "&st=modern"],
    ],
    ["mixed", ["/acme", ",red", "&s=xl", "/cotton", ";spring", ",paris", "&st=modern"]],
    ["slash", ["/acme", "/red", "/xl", "/cotton", "/spring", "/paris", "/modern"]],
  ])("%s cumulative hash yields one binding per facet", (_name, deltas) => {
    const cumulative = deltas.map((_, i) => deltas.slice(0, i + 1).join(""));
    const bindings = extractNavigateToFacetOrder(flowFor(cumulative));
    expect(bindings.map((b) => b.field)).toEqual(FACETS);
    const literals = deltas.map((d) => d.replace(/^[/,&;]/, "").replace(/^[^=]*=/, ""));
    expect(bindings.map((b) => b.value)).toEqual(literals);
  });
});
