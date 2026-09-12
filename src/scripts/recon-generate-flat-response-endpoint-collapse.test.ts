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

  it("collapses a REST mutation-method (POST) group whose response body is byte-identical across every occurrence", () => {
    const group = toGroup(
      Array.from({ length: 3 }, (_, i) =>
        buildCapture({
          url: FLAG_URL,
          method: "POST",
          requestPostData: "[]",
          responseBody: { enabled: true },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );

    expect(isRedundantSameEndpointGroup(group)).toBe(true);
  });

  it("still refuses to collapse a REST mutation-method (POST) group with a genuinely varying response", () => {
    const group = toGroup(
      Array.from({ length: 2 }, (_, i) =>
        buildCapture({
          url: "https://api.example.com/wizard/section",
          method: "POST",
          requestPostData: JSON.stringify({ section: i }),
          responseBody: { id: `section-${i}`, saved: true },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );

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

describe("isRedundantSameEndpointGroup — structural non-semantic-key widening", () => {
  it("collapses a flat toggle re-poll whose sole varying key is a monotonic request id nothing downstream reads", () => {
    const group = toGroup(
      Array.from({ length: 6 }, (_, i) =>
        buildCapture({
          url: FLAG_URL,
          requestPostData: JSON.stringify({ reqSeq: i + 1 }),
          responseBody: { enabled: true },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );

    expect(isRedundantSameEndpointGroup(group)).toBe(false);
    expect(isRedundantSameEndpointGroup(group, group)).toBe(true);
  });

  it("collapses a listing re-fire whose sole varying key is an unread nonce, across the full flow", () => {
    const LISTING_URL = "https://api.example.com/catalog/listing";
    const group = toGroup(
      Array.from({ length: 8 }, (_, i) =>
        buildCapture({
          url: LISTING_URL,
          requestPostData: JSON.stringify({ traceId: `trace-${i}` }),
          responseBody: { items: [{ id: "a" }, { id: "b" }] },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );
    const unrelatedStep = toGroup([
      buildCapture({
        url: "https://api.example.com/catalog/item/a",
        requestPostData: null,
        responseBody: { id: "a", detail: "x" },
        timestamp: "2024-01-01T00:01:00Z",
      }),
    ])[0]!;
    const allActions = [...group, unrelatedStep];

    expect(isRedundantSameEndpointGroup(group)).toBe(false);
    expect(isRedundantSameEndpointGroup(group, allActions)).toBe(true);
  });

  it("collapses a listing re-fire with TWO varying keys, each independently proven dead", () => {
    const LISTING_URL = "https://api.example.com/catalog/listing";
    const group = toGroup(
      Array.from({ length: 8 }, (_, i) =>
        buildCapture({
          url: LISTING_URL,
          requestPostData: JSON.stringify({ traceId: `trace-${i}`, cacheBust: `bust-${i}` }),
          responseBody: { items: [{ id: "a" }, { id: "b" }] },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );
    const unrelatedStep = toGroup([
      buildCapture({
        url: "https://api.example.com/catalog/item/a",
        requestPostData: null,
        responseBody: { id: "a", detail: "x" },
        timestamp: "2024-01-01T00:01:00Z",
      }),
    ])[0]!;
    const allActions = [...group, unrelatedStep];

    expect(isRedundantSameEndpointGroup(group)).toBe(false);
    expect(isRedundantSameEndpointGroup(group, allActions)).toBe(true);
  });

  it("still refuses to collapse when ONE of two varying keys IS read by a later step", () => {
    const LISTING_URL = "https://api.example.com/catalog/listing";
    const group = toGroup(
      Array.from({ length: 2 }, (_, i) =>
        buildCapture({
          url: LISTING_URL,
          requestPostData: JSON.stringify({ traceId: `trace-${i}`, itemId: `item-${i}` }),
          responseBody: { items: [{ id: "a" }, { id: "b" }] },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );
    const drillStep = toGroup([
      buildCapture({
        url: "https://api.example.com/catalog/detail",
        requestPostData: JSON.stringify({ itemId: "item-0" }),
        responseBody: { itemId: "item-0", name: "widget" },
        timestamp: "2024-01-01T00:01:00Z",
      }),
    ])[0]!;
    const allActions = [...group, drillStep];

    expect(isRedundantSameEndpointGroup(group, allActions)).toBe(false);
  });

  it("collapses a paged listing whose page cursor is a non-allowlisted key name that the endpoint's own chained responses hand forward to each other", () => {
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

  it("still refuses to collapse when the sole varying value IS read by a later step (per-item join key)", () => {
    const DETAIL_LOOKUP_URL = "https://api.example.com/catalog/lookup";
    const group = toGroup(
      Array.from({ length: 2 }, (_, i) =>
        buildCapture({
          url: DETAIL_LOOKUP_URL,
          requestPostData: JSON.stringify({ itemId: `item-${i}` }),
          responseBody: { enabled: true },
          timestamp: `2024-01-01T00:00:0${i}Z`,
        })
      )
    );
    const drillStep = toGroup([
      buildCapture({
        url: "https://api.example.com/catalog/detail",
        requestPostData: JSON.stringify({ itemId: "item-0" }),
        responseBody: { itemId: "item-0", name: "widget" },
        timestamp: "2024-01-01T00:01:00Z",
      }),
    ])[0]!;
    const allActions = [...group, drillStep];

    expect(isRedundantSameEndpointGroup(group, allActions)).toBe(false);
  });
});
