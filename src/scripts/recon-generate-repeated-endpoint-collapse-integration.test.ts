import { describe, expect, it } from "vitest";
import { isZeroVarianceRepeatCapture } from "@/recon/capture-filters";
import type { ActionCapture } from "@/scripts/recon-generate";
import { isRedundantSameEndpointGroup } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

function toGroup(captures: Capture[]): ActionCapture[] {
  return captures.map((capture, index) => ({ capture, index }));
}

describe("repeated-endpoint collapse — combined root-cause coverage", () => {
  it("collapses a REST mutation-method group with a byte-identical flat response", () => {
    const group = toGroup(
      Array.from({ length: 3 }, (_, i) =>
        buildCapture({
          url: "https://api.example.com/toggles/flat-flag",
          method: "POST",
          requestPostData: "[]",
          responseBody: { enabled: true },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );

    expect(isRedundantSameEndpointGroup(group)).toBe(true);
  });

  it("collapses a paged listing whose cursor is a non-allowlisted key name chained across the group's own responses", () => {
    const LISTING_URL = "https://api.example.com/catalog/listing";
    const cursors = ["seg-aaa", "seg-bbb", "seg-ccc", "seg-ddd"];
    const group = toGroup(
      cursors.map((cursor, i) =>
        buildCapture({
          url: LISTING_URL,
          requestPostData: JSON.stringify({ facetCursor: cursor }),
          responseBody: {
            items: [{ id: `item-${i}-a` }, { id: `item-${i}-b` }],
            nextFacetCursor: cursors[i + 1] ?? null,
          },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );

    expect(isRedundantSameEndpointGroup(group)).toBe(false);
    expect(isRedundantSameEndpointGroup(group, group)).toBe(true);
  });

  it("excludes a zero-variance opaque-path beacon as noise even though its body varies with a fingerprint", () => {
    const BEACON_URL = "https://api.example.com/beacon?clientId=abc123&siteId=xyz";
    const occurrences = Array.from({ length: 3 }, (_, i) => ({
      method: "POST",
      url: BEACON_URL,
      requestPostData: JSON.stringify({ ts: 1000 + i, nonce: `n-${i}` }),
    }));
    const candidate = {
      ...occurrences[0]!,
      responseHeaders: { "content-type": "application/json" },
      responseBody: { clientId: "abc123", siteId: "xyz" },
    };

    expect(isZeroVarianceRepeatCapture(candidate, occurrences)).toBe(true);
  });
});
