import { describe, expect, it } from "vitest";
import type { ActionCapture } from "@/scripts/recon-generate";
import { isRedundantSameEndpointGroup } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const FLAG_URL = "https://api.example.com/toggles/flat-flag";

function toGroup(captures: Capture[]): ActionCapture[] {
  return captures.map((capture, index) => ({ capture, index }));
}

describe("isRedundantSameEndpointGroup — flat (non-array) responses", () => {
  it("collapses a zero-variance re-poll of a flat, non-array response", () => {
    const group = toGroup(
      Array.from({ length: 3 }, (_, i) =>
        buildCapture({
          url: FLAG_URL,
          requestPostData: "[]",
          responseBody: { enabled: true },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );

    expect(isRedundantSameEndpointGroup(group)).toBe(true);
  });

  it("never collapses a mutation capture, even with a flat single-object response", () => {
    const group = toGroup(
      Array.from({ length: 2 }, (_, i) =>
        buildCapture({
          url: FLAG_URL,
          requestPostData: "[]",
          responseBody: { id: "1", enabled: true },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );
    for (const a of group) {
      a.capture.query = "mutation ToggleFeature { toggleFeature { id enabled } }";
    }

    expect(isRedundantSameEndpointGroup(group)).toBe(false);
  });

  it("still refuses to collapse a group whose flat responses vary in a non-pagination field", () => {
    const group = toGroup(
      Array.from({ length: 2 }, (_, i) =>
        buildCapture({
          url: FLAG_URL,
          requestPostData: JSON.stringify({ itemId: `item-${i}` }),
          responseBody: { enabled: true },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );

    expect(isRedundantSameEndpointGroup(group)).toBe(false);
  });
});
