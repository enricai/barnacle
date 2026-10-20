import { describe, expect, it } from "vitest";
import {
  extractNavigateToFacetOrder,
  matchFacetRecurrence,
  resolveRecurringNavigateToFacets,
  unreferencedDeclaredPayloadFields,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const poolOf = (filters: string[]): Parameters<typeof resolveRecurringNavigateToFacets>[1] => [
  {
    capture: buildCapture({
      url: "https://resort.example.com/search",
      requestPostData: JSON.stringify({ filters }),
      responseBody: {},
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  },
];

const stepsFor = (
  destination: string,
  nights: string
): ReturnType<typeof extractNavigateToFacetOrder> =>
  extractNavigateToFacetOrder(
    [
      { step: `select the '${destination}' destination option`, payloadField: "destination" },
      { step: `select the '${nights}' nights option`, payloadField: "nights" },
    ],
    {}
  );

describe("resolveRecurringNavigateToFacets chokepoint", () => {
  it("keeps both case- and code-differing step facets, each keyed by its element kind", () => {
    const resolved = resolveRecurringNavigateToFacets(
      stepsFor("Lakeside", "4"),
      poolOf(["LK;filterType=destination", "4;filterType=night"])
    );
    const owner = (element: string): string | undefined =>
      matchFacetRecurrence(element, resolved, { allowDelimiterSuffix: true })?.field;
    expect(owner("LK;filterType=destination")).toBe("destination");
    expect(owner("4;filterType=night")).toBe("nights");
    const aliased = resolved.find((f) => f.field === "destination");
    expect(aliased?.keyedByKind).toBe(true);
    expect(aliased?.value).toBe("LK");
  });

  it("binds kind 'night' to field 'nights' and not to destination", () => {
    const resolved = resolveRecurringNavigateToFacets(
      stepsFor("Lakeside", "4"),
      poolOf(["LK;filterType=destination", "4;filterType=night"])
    );
    expect(resolved.filter((f) => f.field === "nights").map((f) => f.value)).toEqual(["4"]);
    expect(resolved.filter((f) => f.field === "destination").map((f) => f.value)).toEqual(["LK"]);
  });

  it("keeps the nights facet in the declared order but resolves nothing for it without a night capture", () => {
    const facets = stepsFor("Lakeside", "4");
    const resolved = resolveRecurringNavigateToFacets(
      facets,
      poolOf(["LK;filterType=destination"])
    );
    expect(facets.map((f) => f.field)).toContain("nights");
    expect(resolved.map((f) => f.field)).toContain("destination");
    expect(resolved.filter((f) => f.field === "nights")).toEqual([]);
  });

  it("still reports the nights facet as unthreaded when no night capture exists", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const code = "const body = { filters: [`${payload.destination};filterType=destination`] };";
    const flow = [
      { step: "select the 'Lakeside' destination option", payloadField: "destination" },
      { step: "select the '4' nights option", payloadField: "nights" },
    ];
    expect(unreferencedDeclaredPayloadFields(code, "", flow)).toEqual(["nights"]);
  });
});
