import { describe, expect, it } from "vitest";
import { isGraphQL } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function cap(method: string, n: number): Capture {
  return {
    timestamp: `2026-08-18T10:23:0${n}.000Z`,
    phase: "p",
    method,
    url: "https://api.example.com/items",
    status: 200,
    requestHeaders: {},
    requestPostData: JSON.stringify({ n }),
    responseHeaders: {},
    responseBody: { id: n },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  } as unknown as Capture;
}

describe("isGraphQL() non-GET write counting across methods", () => {
  it("counts POST and PUT writes to one endpoint together and stays REST", () => {
    const captures = [cap("POST", 1), cap("PUT", 2), cap("GET", 3)];
    expect(isGraphQL(captures)).toBe(false);
  });

  it("flips to GraphQL when the PUT is dropped (the cross-method count decides the vote)", () => {
    const gql = {
      ...cap("POST", 4),
      url: "https://api.example.com/graphql",
      query: "query Foo { a }",
      operationName: "Foo",
    } as unknown as Capture;
    const both = [gql, cap("POST", 1), cap("PUT", 2)];
    expect(isGraphQL(both)).toBe(false);
    expect(isGraphQL([gql, cap("POST", 1)])).toBe(true);
  });
});
