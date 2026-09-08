import { describe, expect, it } from "vitest";
import {
  type ActionCapture,
  dedupRedundantSameOperationCaptures,
  type PrimaryGraphQLOperation,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function buildCapture(overrides: {
  url: string;
  operationName: string | null;
  query: string | null;
  responseBody?: unknown;
}): Capture {
  return {
    timestamp: "2024-05-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody ?? {},
    operationName: overrides.operationName,
    query: overrides.query,
    variables: null,
    decodedParams: null,
  };
}

function buildAction(capture: Capture, index: number): ActionCapture {
  return { capture, index };
}

describe("dedupRedundantSameOperationCaptures", () => {
  it("collapses every redundant re-issue of the primary's operation to the primary's own occurrence", () => {
    const primaryCapture = buildCapture({
      url: "https://api.example.com/catalog/search/",
      operationName: "catalogSearch",
      query: null,
    });
    const redundant1 = buildCapture({
      url: "https://api.example.com/catalog/search/",
      operationName: "catalogSearch",
      query: null,
    });
    const redundant2 = buildCapture({
      url: "https://api.example.com/catalog/search/",
      operationName: "catalogSearch",
      query: null,
    });
    const drill = buildCapture({
      url: "https://api.example.com/catalog/details/",
      operationName: "catalogDetails",
      query: null,
    });

    const actions = [
      buildAction(redundant1, 0),
      buildAction(primaryCapture, 1),
      buildAction(drill, 2),
      buildAction(redundant2, 3),
    ];
    const primary: PrimaryGraphQLOperation = {
      capture: primaryCapture,
      endpointPath: "/catalog/search/",
      unpopulatedDeclaredVariables: [],
    };

    const result = dedupRedundantSameOperationCaptures(actions, primary);

    expect(result).toHaveLength(2);
    expect(result[0]?.capture).toBe(primaryCapture);
    expect(result[1]?.capture).toBe(drill);
  });

  it("always keeps a capture with a distinct operationGroupKey", () => {
    const primaryCapture = buildCapture({
      url: "https://api.example.com/catalog/search/",
      operationName: "catalogSearch",
      query: null,
    });
    const drill = buildCapture({
      url: "https://api.example.com/catalog/details/",
      operationName: "catalogDetails",
      query: null,
    });
    const otherEndpoint = buildCapture({
      url: "https://api.example.com/catalog/recommendations/",
      operationName: "catalogRecommendations",
      query: null,
    });

    const actions = [
      buildAction(primaryCapture, 0),
      buildAction(drill, 1),
      buildAction(otherEndpoint, 2),
    ];
    const primary: PrimaryGraphQLOperation = {
      capture: primaryCapture,
      endpointPath: "/catalog/search/",
      unpopulatedDeclaredVariables: [],
    };

    const result = dedupRedundantSameOperationCaptures(actions, primary);

    expect(result).toHaveLength(3);
    expect(result.map((a) => a.capture)).toEqual([primaryCapture, drill, otherEndpoint]);
  });

  it("passes the sequence through unchanged when no primary was selected", () => {
    const step1 = buildCapture({
      url: "https://api.example.com/apply/submit/",
      operationName: "submitApplication",
      query: null,
    });
    const step2 = buildCapture({
      url: "https://api.example.com/apply/submit/",
      operationName: "submitApplication",
      query: null,
    });

    const actions = [buildAction(step1, 0), buildAction(step2, 1)];

    const result = dedupRedundantSameOperationCaptures(actions, null);

    expect(result).toBe(actions);
    expect(result).toHaveLength(2);
  });

  it("drops a same-endpoint alias whose response resolves to the same array shape as the primary", () => {
    const primaryCapture = buildCapture({
      url: "https://api.example.com/catalog/search/",
      operationName: "catalogSearch",
      query: null,
      responseBody: { data: { search: { results: { items: [{ id: 1 }, { id: 2 }] } } } },
    });
    const alias = buildCapture({
      url: "https://api.example.com/catalog/search/",
      operationName: "catalogSearchAlias",
      query: null,
      responseBody: { data: { search: { results: { items: [{ id: 3 }] } } } },
    });

    const actions = [buildAction(primaryCapture, 0), buildAction(alias, 1)];
    const primary: PrimaryGraphQLOperation = {
      capture: primaryCapture,
      endpointPath: "/catalog/search/",
      unpopulatedDeclaredVariables: [],
    };

    const result = dedupRedundantSameOperationCaptures(actions, primary);

    expect(result).toHaveLength(1);
    expect(result[0]?.capture).toBe(primaryCapture);
  });

  it("keeps a same-endpoint alias whose response resolves to a genuinely different array shape", () => {
    const primaryCapture = buildCapture({
      url: "https://api.example.com/catalog/search/",
      operationName: "catalogSearch",
      query: null,
      responseBody: { data: { search: { results: { items: [{ id: 1 }, { id: 2 }] } } } },
    });
    const distractor = buildCapture({
      url: "https://api.example.com/catalog/search/",
      operationName: "catalogSearchFilters",
      query: null,
      responseBody: { data: { search: { filters: { options: [{ id: "color" }] } } } },
    });

    const actions = [buildAction(primaryCapture, 0), buildAction(distractor, 1)];
    const primary: PrimaryGraphQLOperation = {
      capture: primaryCapture,
      endpointPath: "/catalog/search/",
      unpopulatedDeclaredVariables: [],
    };

    const result = dedupRedundantSameOperationCaptures(actions, primary);

    expect(result).toHaveLength(2);
    expect(result.map((a) => a.capture)).toEqual([primaryCapture, distractor]);
  });
});
