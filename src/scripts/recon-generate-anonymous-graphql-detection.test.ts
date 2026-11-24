import { describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";
import { deriveBaseUrl, isGraphQL } from "./recon-generate";

const H = { "content-type": "application/json" };
const gql = (url: string, query: string): Capture => ({
  timestamp: "2024-01-01T00:00:00Z",
  phase: "load",
  variables: null,
  decodedParams: null,
  method: "POST",
  url,
  requestHeaders: H,
  responseHeaders: H,
  requestPostData: JSON.stringify({ query }),
  responseBody: { data: {} },
  operationName: null,
  query,
  status: 200,
});

describe("anonymous GraphQL documents as detection signal", () => {
  const anon = "query ($input: ItemsInput!) { allItems(input: $input) { name } }";

  it("isGraphQL treats an all-anonymous document pool as GraphQL", () => {
    expect(isGraphQL([gql("https://api.example.test/graphql", anon)])).toBe(true);
  });

  it("isGraphQL stays false for a non-GraphQL query field", () => {
    expect(isGraphQL([gql("https://api.example.test/search", "not graphql")])).toBe(false);
  });

  it("deriveBaseUrl picks the dominant host when same-domain captures are anonymous GraphQL", () => {
    const caps = [
      gql("https://www.example.test/first", "plain"),
      gql("https://api.example.test/graphql", anon),
      gql("https://api.example.test/graphql", "{ itemDetails(id: 1) { id } }"),
    ];
    expect(deriveBaseUrl(caps, [])).toBe("https://api.example.test");
  });
});
