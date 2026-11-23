import { describe, expect, it } from "vitest";
import {
  correlateNavigateToParamsWithVariables,
  renderGqlVariablesExpr,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function cap(input: Record<string, unknown>): Capture {
  const variables = { input };
  const query = "query Search($input: SearchInput!) { search(input: $input) { id } }";
  return {
    timestamp: "t",
    phase: "p",
    method: "POST",
    url: "https://api.example.com/graphql",
    status: 200,
    requestHeaders: {},
    requestPostData: JSON.stringify({
      operationName: "Search",
      query,
      variables,
    }),
    responseHeaders: {},
    responseBody: {},
    operationName: "Search",
    query,
    variables,
    decodedParams: null,
  };
}

const base = "https://x.example.com/find?";
const steps = [
  {
    step: "a",
    navigateTo: `${base}currencyCode=GBP&guests=2`,
    payloadField: "currencyCode",
  },
  {
    step: "b",
    navigateTo: `${base}currencyCode=USD&guests=3`,
    payloadField: "partyCode",
  },
];

describe("navigateTo URL param -> co-varying body variable", () => {
  const caps = [
    cap({ currencyCode: "GBP", partyCode: 2 }),
    cap({ currencyCode: "USD", partyCode: 3 }),
  ];
  it("maps payloadField to the co-varying variable by value", () => {
    const m = correlateNavigateToParamsWithVariables(steps, caps, caps[0]!.variables);
    expect(m.get("partyCode")).toEqual(["input", "partyCode"]);
  });
  it("wires by value even when the variable name differs", () => {
    const c = [cap({ party: 2 }), cap({ party: 3 })];
    const flow = [
      {
        step: "a",
        navigateTo: `${base}guests=2`,
        payloadField: "partyCode",
      },
      { step: "b", navigateTo: `${base}guests=3` },
    ];
    const m = correlateNavigateToParamsWithVariables(flow, c, c[0]!.variables);
    expect(m.get("partyCode")).toEqual(["input", "party"]);
  });
  it("renders payload read so the field is not unread", () => {
    const m = correlateNavigateToParamsWithVariables(steps, caps, caps[0]!.variables);
    const expr = renderGqlVariablesExpr(
      caps[0]!.variables,
      new Set(["currencyCode", "partyCode"]),
      new Set(),
      [],
      m
    );
    expect(expr).toContain("partyCode: payload.partyCode");
  });
  it("does not wire when values do not co-vary", () => {
    const c = [cap({ partyCode: 2 }), cap({ partyCode: 2 })];
    const m = correlateNavigateToParamsWithVariables(steps, c, c[0]!.variables);
    expect(m.size).toBe(0);
  });
  it("ignores interleaved captures of other operations when matching order", () => {
    const other = { ...cap({ x: 1 }), operationName: "Other", query: "query Other { o }" };
    const mixed = [caps[0]!, other, caps[1]!, other];
    const m = correlateNavigateToParamsWithVariables(steps, mixed, caps[0]!.variables);
    expect(m.get("partyCode")).toEqual(["input", "partyCode"]);
  });
  it("does not wire when capture order disagrees with navigateTo step order", () => {
    const reversed = [caps[1]!, caps[0]!];
    const m = correlateNavigateToParamsWithVariables(steps, reversed, reversed[0]!.variables);
    expect(m.size).toBe(0);
  });
});
