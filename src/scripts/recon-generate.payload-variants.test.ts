import { describe, expect, it } from "vitest";
import {
  collectPayloadVariantFields,
  findFrozenVaryingDrillParams,
  resolveFoldPlan,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const URL_ = "https://api.example.com/graphql";

function gql(
  name: string | null,
  query: string,
  variables: Record<string, unknown>,
  responseBody: unknown
): Capture {
  return {
    timestamp: "t",
    phase: "p",
    method: "POST",
    url: URL_,
    status: 200,
    requestHeaders: {},
    requestPostData: JSON.stringify({ operationName: name, query, variables }),
    responseHeaders: {},
    responseBody,
    operationName: name,
    query,
    variables,
    decodedParams: null,
  };
}

const items = [
  { itemId: "item-alpha-111", label: "A" },
  { itemId: "item-beta-222", label: "B" },
];
const searchBody = { data: { search: { results: items } } };

function search(name: string | null, input: Record<string, unknown>): Capture {
  const q = `query ${name ?? ""} ($input: SearchInput!) { search(input: $input) { results { itemId label } } }`;
  return gql(name, name === null ? q.replace("query  (", "query (") : q, { input }, searchBody);
}
const drill = gql(
  "ItemDetail",
  "query ItemDetail($itemId: ID!) { item(id: $itemId) { itemId detail { rooms { code } } } }",
  { itemId: "item-beta-222" },
  {
    data: {
      item: { itemId: "item-beta-222", detail: { rooms: [{ code: "R1" }] } },
    },
  }
);

describe.each([
  ["named search", "Search"],
  ["anonymous read", null],
])("payload variants: %s", (_label, name) => {
  const variants = [
    search(name, { currencyCode: "USD", travelParty: "2A" }),
    search(name, { currencyCode: "EUR", travelParty: "1A" }),
    search(name, { currencyCode: "GBP", travelParty: "2A1C" }),
  ];
  const all = [...variants, drill];
  const actions = all.map((capture) => ({ capture, isMultipart: false }));
  const anchor = `/graphql::${name ?? "search"}`;

  it("folds one drill onto the search primary", () => {
    const plans = resolveFoldPlan(actions, null, anchor);
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(all[plan.primaryStepIndex]!.operationName).toBe(name);
    expect(plan.targets).toHaveLength(1);
    expect(all[plan.targets[0]!.drillStepIndex]).toBe(drill);
  });

  it("variant captures are not frozen-varying drills", () => {
    const rendered = variants[1]!.requestPostData!;
    expect(findFrozenVaryingDrillParams(variants[1]!, rendered, all)).toEqual([]);
  });

  it("exposes variant fields as payload fields", () => {
    expect(collectPayloadVariantFields(variants[0]!, all)).toEqual([
      "input.currencyCode",
      "input.travelParty",
    ]);
  });
});
