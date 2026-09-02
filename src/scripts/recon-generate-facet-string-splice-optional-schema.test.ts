import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Proves the payload zod schema stays consistent with the emitted splice
 * expression: a facet field emitted through the conditional-omission path
 * is `.optional()`, while a facet marked required stays a plain required
 * field. Domain-neutral fixture (region/brand/len) — not tied to any site
 * or plugin.
 */
describe("emitContractTs — payload schema marks a facet field .optional() only when its facet is optional", () => {
  it("emits .optional() for optional facets and a plain required field for the required facet", () => {
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
      gqlVariables: { filters: "region:R1|brand:B1|len:3~5" },
      payloadFieldNames: new Set(["Region", "Brand", "Len"]),
      optionalPayloadFieldNames: new Set(["Brand", "Len"]),
      auxFiles: [],
    });

    expect(source).toMatch(/Brand: z\.string\(\)\.optional\(\),/);
    expect(source).toMatch(/Len: z\.string\(\)\.optional\(\),/);
    expect(source).toMatch(/Region: z\.string\(\),/);
    expect(source).not.toMatch(/Region: z\.string\(\)\.optional\(\),/);
  });
});
