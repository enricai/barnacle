import { describe, expect, it } from "vitest";
import {
  type NavigateToFacetBinding,
  resolveRecurringNavigateToFacets,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

describe("resolveRecurringNavigateToFacets — kind-keyed alias vocabulary", () => {
  it("records the declared-to-code value mapping on the alias binding", () => {
    const declared: NavigateToFacetBinding[] = [
      { value: "december", field: "month", optional: false, kind: "date" },
    ];
    const actions = [
      {
        capture: buildCapture({
          url: "https://catalogue.example.com/quote/",
          requestPostData: JSON.stringify({ filters: ["2026-12;filterType=date"] }),
          responseBody: {},
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
      },
    ] as unknown as Parameters<typeof resolveRecurringNavigateToFacets>[1];
    const alias = resolveRecurringNavigateToFacets(declared, actions).find((f) => f.keyedByKind);
    expect(alias?.value).toBe("2026-12");
    expect(alias?.valueMap?.get("december")).toBe("2026-12");
  });

  it("maps only the declared value, never another quoted span of the same step", () => {
    const declared: NavigateToFacetBinding[] = [
      {
        value: "Los Angeles",
        field: "destination",
        optional: false,
        origin: "step",
        literals: ["Los Angeles", "Dec 2026"],
        kind: "destination",
      },
    ];
    const actions = [
      {
        capture: buildCapture({
          url: "https://catalogue.example.com/quote/",
          requestPostData: JSON.stringify({ filters: ["LAX;filterType=destination"] }),
          responseBody: {},
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
      },
    ] as unknown as Parameters<typeof resolveRecurringNavigateToFacets>[1];
    const alias = resolveRecurringNavigateToFacets(declared, actions).find((f) => f.keyedByKind);
    expect([...(alias?.valueMap ?? [])]).toEqual([["Los Angeles", "LAX"]]);
  });
});
