import { describe, expect, it } from "vitest";
import {
  extractNavigateToFacetOrder,
  resolveRecurringNavigateToFacets,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

describe("kind-keyed facet resolution", () => {
  const facets = extractNavigateToFacetOrder(
    [
      { step: "select the 'Lisbon' city option", payloadField: "destination" },
      { step: "select the '3' nights option", payloadField: "stayLength" },
    ],
    {}
  );

  it("owns every element of the kind, whatever its case or code", () => {
    const actions = [
      {
        capture: buildCapture({
          url: "https://shop.example.com/search",
          requestPostData: JSON.stringify({
            filters: ["LIS;filterType=city", "PRT;filterType=city", "N3;filterType=nights"],
          }),
          responseBody: {},
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
      },
    ];
    const resolved = resolveRecurringNavigateToFacets(facets, actions);
    const city = resolved.filter((f) => f.field === "destination").map((f) => f.value);
    expect(city).toEqual(expect.arrayContaining(["LIS", "PRT"]));
    expect(resolved.some((f) => f.field === "stayLength" && f.value === "N3")).toBe(true);
  });
});
