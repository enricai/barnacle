import { describe, expect, it } from "vitest";
import {
  collectRequestBodyValuesByKey,
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const cap = (body: unknown): Capture =>
  ({ url: "https://x/search", method: "POST", requestPostData: JSON.stringify(body) }) as Capture;

describe("collectRequestBodyValuesByKey — genuine variance still reported", () => {
  it("flags a same-shape array whose element identity differs across captures", () => {
    const a = cap({ filters: ["red;facetId=color", "XL;facetType=size"] });
    const b = cap({ filters: ["blue;facetId=color", "XL;facetType=size"] });
    const byKey = collectRequestBodyValuesByKey(a, [a, b])!;
    expect(byKey.has("filters")).toBe(true);
    expect([...byKey.get("filters")!]).toEqual(["red;facetId=color"]);
  });

  it("flags a same-length array of objects with a genuinely different element", () => {
    const a = cap({ items: [{ sku: "a" }, { sku: "b" }] });
    const b = cap({ items: [{ sku: "a" }, { sku: "c" }] });
    const byKey = collectRequestBodyValuesByKey(a, [a, b])!;
    expect([...byKey.keys()]).toEqual(["sku"]);
    expect([...byKey.get("sku")!]).toEqual(["b"]);
  });

  it("still flags a varying scalar body field", () => {
    const a = cap({ filters: ["red;facetId=color"], page: 1 });
    const b = cap({ filters: ["red;facetId=color"], page: 2 });
    const byKey = collectRequestBodyValuesByKey(a, [a, b])!;
    expect([...byKey.get("page")!]).toEqual(["1"]);
    expect(byKey.has("filters")).toBe(false);
  });
});

describe("emitContractTs — genuine variance still hard fails", () => {
  const BASE = "https://api.example.com";
  const SPEC: FoldReturnSpec = {
    endpointPattern: "/catalog/pricing/",
    resultsPath: "results",
    joinFields: ["sku"],
  };
  const search = {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/search?page=1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
  const drill = (sku: string, region: string, ts: string): unknown => ({
    ...search,
    timestamp: ts,
    url: `${BASE}/catalog/pricing/?sku=${sku}&region=${region}`,
    responseBody: { results: [{ sku, amount: 19.99 }] },
  });

  const build = (captures: unknown[]): string => {
    const actions = extractGraphQLActionSequence(captures as never[], null, SPEC);
    const state = indexStateValues(
      captures as never[],
      new Set(),
      new Set(actions.map((a) => a.index))
    );
    return emitContractTs({
      siteId: "genuine-body-variance-test",
      pascal: "GenuineBodyVarianceTest",
      baseUrl: BASE,
      baseHeaders: {},
      minTime: 100,
      safeRps: 10,
      responseBody: search.responseBody,
      gql: false,
      gqlQuery: null,
      endpointPath: "/catalog/search",
      gqlOperationName: null,
      gqlVariables: null,
      auxFiles: [],
      actionSteps: compileActionSteps(actions, state),
      foldReturnSpec: SPEC,
    });
  };

  it("throws when a drill query param varies and nothing threads it", () => {
    expect(() =>
      build([
        search,
        drill("sku-a", "us", "2024-01-01T00:00:01Z"),
        drill("sku-b", "eu", "2024-01-01T00:00:02Z"),
      ])
    ).toThrow(/region/);
  });

  it("does not throw when the drill query param is constant", () => {
    expect(() =>
      build([
        search,
        drill("sku-a", "us", "2024-01-01T00:00:01Z"),
        drill("sku-b", "us", "2024-01-01T00:00:02Z"),
      ])
    ).not.toThrow();
  });
});
