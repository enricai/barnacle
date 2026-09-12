import { describe, expect, it } from "vitest";
import type { ActionCapture } from "@/scripts/recon-generate";
import { isRedundantSameEndpointGroup } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

function toGroup(captures: Capture[]): ActionCapture[] {
  return captures.map((capture, index) => ({ capture, index }));
}

describe("recon-generate — value-coincidence false positive vs. genuine path-segment threading", () => {
  it("collapses a same-endpoint group whose short page counter coincidentally string-equals an unrelated leaf under a DIFFERENT field name across a 60-capture corpus", () => {
    const LISTING_URL = "https://api.example.com/catalog/listing";
    const group = toGroup(
      ["1", "2", "3"].map((page, i) =>
        buildCapture({
          url: `${LISTING_URL}?page=${page}`,
          requestPostData: null,
          responseBody: { items: [{ id: `item-${i}` }] },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );
    const unrelatedCorpus = Array.from({ length: 60 }, (_, i) =>
      buildCapture({
        url: `https://api.example.com/unrelated/${i}`,
        requestPostData: null,
        // "1", "2", "3" show up as unrelated leaves under a DIFFERENT key
        // ("count", not "page") purely by coincidence across a large corpus.
        responseBody: { count: String((i % 3) + 1), label: `entry-${i}` },
        timestamp: `2024-01-02T00:${String(i).padStart(2, "0")}:00Z`,
      })
    );
    const allActions = toGroup([...group.map((g) => g.capture), ...unrelatedCorpus]);

    expect(isRedundantSameEndpointGroup(group, allActions)).toBe(true);
  });

  it("does NOT collapse when a varying field's value is genuinely threaded into a later request's URL PATH segment", () => {
    const group = toGroup(
      ["1", "2", "3"].map((itemId, i) =>
        buildCapture({
          url: `https://api.example.com/catalog/listing?itemId=${itemId}`,
          requestPostData: null,
          responseBody: { items: [{ id: `x-${i}` }] },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );
    const drillCapture = buildCapture({
      url: "https://api.example.com/items/1/details",
      requestPostData: null,
      responseBody: { detail: "d" },
      timestamp: "2024-01-01T00:01:00Z",
    });
    const allActions = toGroup([...group.map((g) => g.capture), drillCapture]);

    expect(isRedundantSameEndpointGroup(group, allActions)).toBe(false);
  });
});
