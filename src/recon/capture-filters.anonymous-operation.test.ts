import { describe, expect, it } from "vitest";
import { isZeroVarianceRepeatCapture, parsedOperationName } from "./capture-filters";

const URL_ = "https://shop.example.test/graphql";
const H = { "content-type": "application/json" };
const cap = (query: string, variables: unknown, resp: unknown, op: string | null = null) => ({
  method: "POST",
  url: URL_,
  requestHeaders: H,
  responseHeaders: H,
  requestPostData: JSON.stringify({ query, variables }),
  responseBody: resp,
  operationName: op,
  query,
  status: 200,
});
const ANON = "query ($input: ItemsInput!) { allItems(input: $input) { name region } }";
const chrome = (i: number) =>
  cap("query Nav { menu { id } }", {}, { data: { menu: [{ id: "a" }] } }, "Nav");

describe("anonymous GraphQL identity", () => {
  it("derives root-field identity", () => {
    expect(parsedOperationName(ANON)).toBe("allItems");
    expect(parsedOperationName("{ itemDetails(id: 1) { id } }")).toBe("itemDetails");
    expect(parsedOperationName("query Named { x }")).toBe("Named");
    expect(parsedOperationName("not graphql")).toBeNull();
  });
  it("retains anonymous search among repeating chrome, drops chrome", () => {
    const search = [
      cap(ANON, { input: { currencyCode: "USD", travelParty: 2 } }, { data: { allItems: [{ name: "a" }] } }),
      cap(ANON, { input: { currencyCode: "GBP", travelParty: 2 } }, { data: { allItems: [{ name: "b" }] } }),
      cap(ANON, { input: { currencyCode: "USD", travelParty: 3 } }, { data: { allItems: [{ name: "c" }] } }),
    ];
    const all = [chrome(0), chrome(1), chrome(2), chrome(3), ...search];
    for (const s of search) expect(isZeroVarianceRepeatCapture(s, all)).toBe(false);
    expect(isZeroVarianceRepeatCapture(all[0], all)).toBe(true);
  });
  it("retains a once-fired anonymous read", () => {
    const one = cap(ANON, { input: { currencyCode: "USD" } }, { data: { allItems: [{ name: "a" }] } });
    const all = [chrome(0), chrome(1), chrome(2), one];
    expect(isZeroVarianceRepeatCapture(one, all)).toBe(false);
  });
});
