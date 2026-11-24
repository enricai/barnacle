import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";

const BASE = "https://api.example.test";

/**
 * Regression: a browser-flow-only contract (`omitExecuteHttp: true`) emits no
 * `executeHttp`, so the frozen-but-varying drill assertion must not abort on a
 * client-generated body field (here `updatedAt`) that differs across the
 * multi-step PUT captures. With `omitExecuteHttp: false` the assertion still
 * applies and must throw.
 */

function searchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/orders/search?page=1`,
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
}

function putCapture(sku: string, body: unknown, ts: string): unknown {
  return {
    timestamp: ts,
    phase: "browse",
    method: "PUT",
    url: `${BASE}/orders/update/?sku=${sku}`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify(body),
    responseHeaders: {},
    responseBody: { results: [{ sku, ok: true }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/orders/update/",
  resultsPath: "results",
  joinFields: ["sku"],
};

function build(omitExecuteHttp: boolean): string {
  const captures = [
    searchCapture(),
    putCapture(
      "sku-a",
      { order: { contactName: "Jane Doe", updatedAt: "2026-11-22T19:57:19.662-08:00" } },
      "2024-01-01T00:00:01Z"
    ),
    putCapture(
      "sku-b",
      { order: { contactEmail: "jane@example.com", updatedAt: "2026-11-22T20:00:25.542-08:00" } },
      "2024-01-01T00:00:02Z"
    ),
  ];
  const actionCaptures = extractGraphQLActionSequence(captures as never[], null, SPEC);
  const stateIndex = indexStateValues(
    captures as never[],
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);
  return emitContractTs({
    siteId: "frozen-varying-body-test",
    pascal: "FrozenVaryingBodyTest",
    baseUrl: BASE,
    baseHeaders: {},
    minTime: 100,
    safeRps: 10,
    responseBody: (searchCapture() as { responseBody: unknown }).responseBody,
    gql: false,
    gqlQuery: null,
    endpointPath: "/orders/search",
    gqlOperationName: null,
    gqlVariables: null,
    auxFiles: [],
    actionSteps,
    foldReturnSpec: SPEC,
    omitExecuteHttp,
  });
}

describe("emitContractTs — browser-flow-only with frozen varying body value", () => {
  it("does not throw and emits no executeHttp when omitExecuteHttp is true", () => {
    let source = "";
    expect(() => {
      source = build(true);
    }).not.toThrow();
    expect(source).not.toContain("async executeHttp(");
  });

  it("still throws when omitExecuteHttp is false", () => {
    expect(() => build(false)).toThrow(/updatedAt/);
  });
});
