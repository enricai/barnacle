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
    navigateTo: `${base}currencyCode=GBP&sailors=2`,
    payloadField: "currencyCode",
  },
  {
    step: "b",
    navigateTo: `${base}currencyCode=USD&sailors=3`,
    payloadField: "travelParty",
  },
];

describe("navigateTo URL param -> co-varying body variable", () => {
  const caps = [
    cap({ currencyCode: "GBP", travelParty: 2 }),
    cap({ currencyCode: "USD", travelParty: 3 }),
  ];
  it("maps payloadField to the co-varying variable by value", () => {
    const m = correlateNavigateToParamsWithVariables(steps, caps, caps[0]!.variables);
    expect(m.get("travelParty")).toEqual(["input", "travelParty"]);
  });
  it("wires by value even when the variable name differs", () => {
    const c = [cap({ party: 2 }), cap({ party: 3 })];
    const flow = [
      {
        step: "a",
        navigateTo: `${base}sailors=2`,
        payloadField: "travelParty",
      },
      { step: "b", navigateTo: `${base}sailors=3` },
    ];
    const m = correlateNavigateToParamsWithVariables(flow, c, c[0]!.variables);
    expect(m.get("travelParty")).toEqual(["input", "party"]);
  });
  it("renders payload read so the field is not unread", () => {
    const m = correlateNavigateToParamsWithVariables(steps, caps, caps[0]!.variables);
    const expr = renderGqlVariablesExpr(
      caps[0]!.variables,
      new Set(["currencyCode", "travelParty"]),
      new Set(),
      [],
      m
    );
    expect(expr).toContain("travelParty: payload.travelParty");
  });
  it("does not wire when values do not co-vary", () => {
    const c = [cap({ travelParty: 2 }), cap({ travelParty: 2 })];
    const m = correlateNavigateToParamsWithVariables(steps, c, c[0]!.variables);
    expect(m.size).toBe(0);
  });
});
