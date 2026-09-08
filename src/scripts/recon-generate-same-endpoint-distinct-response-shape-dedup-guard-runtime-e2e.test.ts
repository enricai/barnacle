import { describe, expect, it } from "vitest";
import {
  type ActionCapture,
  dedupRedundantSameOperationCaptures,
  type PrimaryGraphQLOperation,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression guard for the shape-aware dedup key introduced to collapse an
 * aliased re-issue of the primary read (differing operationName, same
 * endpoint, same response array shape). This is the inverse failure mode: a
 * too-greedy key that keys on endpoint alone (dropping the array-path
 * comparison) would ALSO collapse genuinely distinct same-endpoint
 * operations, e.g. a catalog's facet/filter-options reads sharing the
 * primary search's endpoint. Those must survive as their own occurrences
 * since their response shape (top-level result field / array path) never
 * matches the primary's.
 */

const ENDPOINT = "https://api.example.com/graphql";

function buildCapture(overrides: { operationName: string | null; responseBody: unknown }): Capture {
  return {
    timestamp: "2024-05-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: ENDPOINT,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function buildAction(capture: Capture, index: number): ActionCapture {
  return { capture, index };
}

describe("dedupRedundantSameOperationCaptures — same-endpoint distinct response shape survives", () => {
  it("keeps every same-endpoint capture whose response shape genuinely differs from the primary's, while still collapsing true re-issues of the primary", () => {
    const primaryCapture = buildCapture({
      operationName: "catalogSearch",
      responseBody: { catalogSearch: { items: [{ id: "item-1", title: "Item 1" }] } },
    });
    // A true re-issue of the primary under a different variable set --
    // same endpoint, same operationGroupKey, same response array path
    // ("catalogSearch.items") -- must still collapse into the primary.
    const primaryReissue = buildCapture({
      operationName: "catalogSearch",
      responseBody: { catalogSearch: { items: [{ id: "item-2", title: "Item 2" }] } },
    });
    // Two genuinely distinct same-endpoint operations: different
    // operationName AND a different top-level result field / array path,
    // standing in for a report's facet/filter-options reads that share the
    // primary's endpoint but are not part of its declared foldReturn.
    const facetsCapture = buildCapture({
      operationName: "catalogFacets",
      responseBody: { catalogFacets: { facets: [{ id: "facet-1", name: "Color" }] } },
    });
    const filterOptionsCapture = buildCapture({
      operationName: "catalogFilterOptions",
      responseBody: {
        catalogFilterOptions: { options: [{ id: "option-1", label: "In stock" }] },
      },
    });

    const actions = [
      buildAction(primaryCapture, 0),
      buildAction(facetsCapture, 1),
      buildAction(primaryReissue, 2),
      buildAction(filterOptionsCapture, 3),
    ];
    const primary: PrimaryGraphQLOperation = {
      capture: primaryCapture,
      endpointPath: "/graphql",
      unpopulatedDeclaredVariables: [],
    };

    const result = dedupRedundantSameOperationCaptures(actions, primary);

    // The primary's own read call site count is exactly 1 -- the re-issue
    // collapses into it, the same shape-aware behavior the fix introduced.
    const primaryOccurrences = result.filter(
      (a) => (a.capture as { operationName: string | null }).operationName === "catalogSearch"
    );
    expect(primaryOccurrences).toHaveLength(1);
    expect(primaryOccurrences[0]?.capture).toBe(primaryCapture);

    // Neither distinct-shape capture is silently dropped: both remain as
    // their own ActionCapture entries, distinguishable from the primary's
    // occurrence -- a too-greedy endpoint-only key would have swallowed
    // them here too.
    expect(result).toContainEqual(buildAction(facetsCapture, 1));
    expect(result).toContainEqual(buildAction(filterOptionsCapture, 3));
    expect(result.map((a) => a.capture)).toContain(facetsCapture);
    expect(result.map((a) => a.capture)).toContain(filterOptionsCapture);

    // Total shape: primary once + the two genuinely distinct operations,
    // not the re-issue.
    expect(result).toHaveLength(3);
    expect(result.map((a) => a.capture)).toEqual([
      primaryCapture,
      facetsCapture,
      filterOptionsCapture,
    ]);
  });
});
