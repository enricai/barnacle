import { describe, expect, it } from "vitest";
import type { ActionCapture } from "@/scripts/recon-generate";
import { isRedundantSameEndpointGroup } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

function toGroup(captures: Capture[]): ActionCapture[] {
  return captures.map((capture, index) => ({ capture, index }));
}

const LISTING_URL = "https://api.example.com/catalog/listing";

function buildGroup(): ActionCapture[] {
  return toGroup(
    Array.from({ length: 8 }, (_, i) =>
      buildCapture({
        url: `${LISTING_URL}?reqTag=req-${i}`,
        requestPostData: null,
        responseBody: { items: [{ id: `item-${i}` }] },
        timestamp: `2024-01-01T00:00:0${i}Z`,
      })
    )
  );
}

describe("recon-generate — array-shaped group collapse via non-allowlisted, non-pagination-named key", () => {
  it("collapses an 8-member array-shaped group whose only varying field (a non-cache-buster, non-pagination-named request-tracking key) is proven never read by any other capture", () => {
    const group = buildGroup();
    const otherCapture = buildCapture({
      url: "https://api.example.com/unrelated/endpoint",
      requestPostData: null,
      responseBody: { label: "entry" },
      timestamp: "2024-01-02T00:00:00Z",
    });
    const allActions = toGroup([...group.map((g) => g.capture), otherCapture]);

    expect(isRedundantSameEndpointGroup(group, allActions)).toBe(true);
  });

  it("does NOT collapse the same shape when the varying field's value IS read elsewhere (negative control)", () => {
    const group = buildGroup();
    const drillCapture = buildCapture({
      url: "https://api.example.com/details",
      requestPostData: null,
      responseBody: { reqTag: "req-3" },
      timestamp: "2024-01-01T00:01:00Z",
    });
    const allActions = toGroup([...group.map((g) => g.capture), drillCapture]);

    expect(isRedundantSameEndpointGroup(group, allActions)).toBe(false);
  });

  it("does NOT collapse when allActions is omitted (conservative fallback, existing behavior)", () => {
    const group = buildGroup();

    expect(isRedundantSameEndpointGroup(group)).toBe(false);
  });
});
