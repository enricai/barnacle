import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Regression coverage for the executeHttp payload/_payload param-name guard
 * (bugfix-001): the generated signature keeps `payload` when a GraphQL
 * variable — top-level key or facet-string segment — correlates to a
 * payloadField, and renames it to `_payload` when none does at all, so the
 * generated skeleton never carries a standing Biome noUnusedFunctionParameters
 * warning.
 */
describe("emitContractTs — executeHttp payload/_payload param-name guard", () => {
  it("keeps the `payload` param name when a GraphQL variable correlates to a payloadField", () => {
    const source = emitContractTs({
      siteId: "catalog-example",
      pascal: "CatalogExample",
      baseUrl: "https://catalog-example.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { products: [{ id: "p-1", name: "Widget" }] },
      gql: true,
      gqlQuery:
        "query productSearch_Products($category: String) { products(category: $category) { id name } }",
      endpointPath: "/graphql",
      gqlOperationName: "productSearch_Products",
      gqlVariables: { category: "widgets" },
      payloadFieldNames: new Set(["Category"]),
      auxFiles: [],
    });

    const executeHttpMatch = source.match(/async executeHttp\([\s\S]*?\n {2}},\n/);
    expect(executeHttpMatch).not.toBeNull();
    const executeHttpBody = executeHttpMatch?.[0] ?? "";

    expect(executeHttpBody).toContain("async executeHttp(\n    payload:");
    expect(executeHttpBody).not.toContain("_payload:");
  });

  it("renames the param to `_payload` when no GraphQL variable correlates to any payloadField", () => {
    const source = emitContractTs({
      siteId: "catalog-example",
      pascal: "CatalogExample",
      baseUrl: "https://catalog-example.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { products: [{ id: "p-1", name: "Widget" }] },
      gql: true,
      gqlQuery:
        "query productSearch_Products($filters: String) { products(filters: $filters) { id name } }",
      endpointPath: "/graphql",
      gqlOperationName: "productSearch_Products",
      gqlVariables: { filters: "brand:acme|priceRange:10~50" },
      payloadFieldNames: new Set(["Category"]),
      auxFiles: [],
    });

    const executeHttpMatch = source.match(/async executeHttp\([\s\S]*?\n {2}},\n/);
    expect(executeHttpMatch).not.toBeNull();
    const executeHttpBody = executeHttpMatch?.[0] ?? "";

    expect(executeHttpBody).toContain("_payload:");
    expect(executeHttpBody).not.toMatch(/[^_]payload\./);
  });
});
