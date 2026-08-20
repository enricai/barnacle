import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Integration coverage for the reported symptom: a generated contract.ts's
 * executeHttp for a GraphQL read/inventory flow whose payloadFields live
 * inside a string filter variable (a delimited `key:value` facet grammar,
 * e.g. `category:widgets|priceRange:10~50`) must actually reference
 * `payload.<Field>` — not just capture `payload` as an unused parameter.
 * Distinct from recon-generate-gql-facet-string-bind.test.ts (bugfix-001,
 * a unit test of the isolated helper): this drives the whole
 * emitContractTs code-generation path — gqlOperationName + gqlVariables +
 * payloadFieldNames flowing through to the emitted getGql(...) call site —
 * matching the actual reported call path.
 */
describe("emitContractTs — facet-string GraphQL variable end-to-end emission", () => {
  it("splices payload.<Field> into the getGql(...) variables literal for a facet-shaped string variable", () => {
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
      gqlVariables: { filters: "category:widgets|priceRange:10~50" },
      payloadFieldNames: new Set(["Category"]),
      auxFiles: [],
    });

    const executeHttpMatch = source.match(/async executeHttp\([\s\S]*?\n {2}},\n/);
    expect(executeHttpMatch).not.toBeNull();
    const executeHttpBody = executeHttpMatch?.[0] ?? "";

    // The reported symptom: payload must be READ, not merely captured. Assert
    // the payload.<Field> reference lives inside the getGql(...) call site
    // itself, spliced into the variables literal — not just present anywhere
    // in the generated file.
    const getGqlCallMatch = executeHttpBody.match(/await getGql\(context\.baseUrl\)\([^;]*\);/);
    expect(getGqlCallMatch).not.toBeNull();
    const getGqlCall = getGqlCallMatch?.[0] ?? "";

    expect(getGqlCall).toContain('"productSearch_Products"');
    expect(getGqlCall).toContain("filters: `category:$" + "{payload.Category}|priceRange:10~50`");

    // The unused-parameter defect this closes: payload is referenced inside
    // executeHttp, so `payload` in the function signature is not dead.
    expect(executeHttpBody).toMatch(/payload\.Category/);
  });

  it("keeps the JSON.stringify fallback (no payload reference) when no facet correlates — the pre-fix shape", () => {
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
    const executeHttpBody = executeHttpMatch?.[0] ?? "";
    const getGqlCallMatch = executeHttpBody.match(/await getGql\(context\.baseUrl\)\([^;]*\);/);
    const getGqlCall = getGqlCallMatch?.[0] ?? "";

    expect(getGqlCall).toContain('filters: "brand:acme|priceRange:10~50"');
    expect(getGqlCall).not.toContain("payload.");
  });
});
