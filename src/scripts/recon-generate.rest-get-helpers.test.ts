import { describe, expect, it } from "vitest";
import {
  buildPaginatedFetchLoopExecuteHttpBody,
  captureRequestParams,
  detectPaginationSignal,
  type GetInputModel,
  pruneGetInputModelKeys,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://shop.example/api/products";
const body = (n: number) => ({
  total: 40,
  items: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `p${i}` })),
});
const get = (url: string, responseBody: unknown) =>
  buildCapture({
    url,
    requestPostData: null,
    responseBody,
    timestamp: "2024-01-01T00:00:00Z",
    method: "GET",
  });

describe("pruneGetInputModelKeys", () => {
  it("drops the given query keys and their fields", () => {
    const model: GetInputModel = {
      dynamicFields: [
        { field: "limit", queryKey: "limit" },
        { field: "color", queryKey: "color" },
      ],
      fixedParams: { offset: "0", sort: "price" },
      fieldToQueryKey: { limit: "limit", color: "color" },
      pathVars: [],
    };
    const out = pruneGetInputModelKeys(model, ["limit", "offset"]);
    expect(out.dynamicFields).toEqual([{ field: "color", queryKey: "color" }]);
    expect(out.fixedParams).toEqual({ sort: "price" });
    expect(out.fieldToQueryKey).toEqual({ color: "color" });
  });
});

describe("captureRequestParams", () => {
  it("returns null for no capture, recorded params, bad URL, or empty query", () => {
    expect(captureRequestParams(null)).toBeNull();
    expect(captureRequestParams(get("not a url", {}))).toBeNull();
    expect(captureRequestParams(get(BASE, {}))).toBeNull();
    const c = { ...get(`${BASE}?a=1`, {}), variables: { x: 1 } };
    expect(captureRequestParams(c)).toEqual({ x: 1 });
  });
  it("reads a GET's query with numeric coercion", () => {
    expect(captureRequestParams(get(`${BASE}?limit=12&offset=0&sort=price`, {}))).toEqual({
      limit: 12,
      offset: 0,
      sort: "price",
    });
  });
});

describe("GET paging through real call path", () => {
  const full = get(`${BASE}?limit=12&offset=0`, body(12));
  const partial = get(`${BASE}?limit=12&offset=36`, body(4));
  const identity = `${new URL(BASE).pathname}::anonymous`;

  it("finds the signal from a sibling GET capture's URL query", () => {
    const signal = detectPaginationSignal(partial.responseBody, null, identity, [partial, full]);
    expect(signal).not.toBeNull();
    expect(signal?.countKey).toBe("limit");
    expect(signal?.skipKey).toBe("offset");
  });

  it("emits a loop without a baseVariables line for a REST GET", () => {
    const signal = detectPaginationSignal(partial.responseBody, null, identity, [partial, full])!;
    const model: GetInputModel = {
      dynamicFields: [],
      fixedParams: {},
      fieldToQueryKey: {},
      pathVars: [],
    };
    const rest = buildPaginatedFetchLoopExecuteHttpBody({
      pascal: "X",
      gqlVariablesExpr: "{}",
      signal,
      foldMergeLines: [],
      fetchCall: { kind: "rest", endpointPath: "/api/products", getInputModel: model },
    });
    expect(rest).not.toContain("const baseVariables");
    expect(rest).toContain("PAGE_SIZE");
    const gql = buildPaginatedFetchLoopExecuteHttpBody({
      pascal: "X",
      gqlVariablesExpr: "{}",
      signal,
      foldMergeLines: [],
      fetchCall: { kind: "gql", gqlOperationNameExpr: '"Op"', queryConstName: "Q" },
    });
    expect(gql).toContain("const baseVariables = {};");
  });
});
