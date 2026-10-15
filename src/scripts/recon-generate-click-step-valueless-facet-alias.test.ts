import { describe, expect, it } from "vitest";
import {
  type NavigateToFacetBinding,
  resolveRecurringNavigateToFacets,
} from "@/scripts/recon-generate";
import type { ActionStep } from "@/scripts/recon-shared";

const ACTIONS = [
  {
    capture: {
      url: "https://shop.example.com/quote/",
      requestPostData: JSON.stringify({
        filters: ["GADGETS;filterType=category", "RED;filterType=color"],
      }),
      requestHeaders: {},
    },
  },
] as unknown as Pick<ActionStep, "capture">[];

describe("resolveRecurringNavigateToFacets — click facet without a step literal", () => {
  it("resolves the facet from its own kind-keyed element like a literal-bearing one", () => {
    const declared: NavigateToFacetBinding[] = [
      { value: "", field: "color", optional: false, origin: "step", kind: "color", literals: [] },
    ];
    const resolved = resolveRecurringNavigateToFacets(declared, ACTIONS);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ field: "color", value: "RED", keyedByKind: true });
  });
});
