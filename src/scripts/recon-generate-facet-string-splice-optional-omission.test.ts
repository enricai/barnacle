import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Proves the reported symptom is fixed at the splice-expression code path: an
 * omitted optional facet's `key:value` segment is dropped entirely from the
 * emitted getGql(...) variables literal, rather than emitting `key:undefined`.
 * Domain-neutral fixture (region/brand/len) — not tied to any site or plugin.
 */
describe("emitContractTs — facet-string splice drops an omitted optional facet's segment", () => {
  it("emits a conditionally-joined array for a facet string with optional fields", () => {
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

    const executeHttpMatch = source.match(/async executeHttp\([\s\S]*?\n {2}},\n/);
    expect(executeHttpMatch).not.toBeNull();
    const executeHttpBody = executeHttpMatch?.[0] ?? "";

    const getGqlCallMatch = executeHttpBody.match(/await getGql\(context\.baseUrl\)\([^;]*\);/);
    expect(getGqlCallMatch).not.toBeNull();
    const getGqlCall = getGqlCallMatch?.[0] ?? "";

    // Structural shape, not a frozen exact string: a conditionally-joined
    // array, with each optional facet's segment guarded on its payload value.
    expect(getGqlCall).toContain('.join("|")');
    expect(getGqlCall).toMatch(/payload\.Brand\s*\?/);
    expect(getGqlCall).toMatch(/payload\.Len\s*\?/);

    // The required facet (region) is never guarded — it always contributes.
    expect(getGqlCall).not.toMatch(/payload\.Region\s*\?/);

    // The reported defect: an absent optional facet must never surface as
    // `key:undefined` anywhere in the generated call site.
    expect(getGqlCall).not.toContain("undefined");
  });
});
