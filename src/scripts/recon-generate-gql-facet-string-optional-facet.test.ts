import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Integration coverage for the doc's own worked example
 * (docs/recon-generate-string-facet-splice-cannot-omit-optional-facets.md,
 * "Reproduction" section): a facet-string GraphQL variable with a mix of
 * required and optional payload fields must drop an omitted optional
 * facet's segment (and delimiter) cleanly — no `key:undefined` — while a
 * present optional facet still emits, and the payload schema marks the
 * optional facets `.optional()` while the required facet stays required.
 */
describe("emitContractTs — facet-string GraphQL variable with optional facets", () => {
  const buildOpts = () => ({
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

  it("emits a conditionally-joined array with the required facet always present and optional facets included when payload has them", () => {
    const source = emitContractTs(buildOpts());

    expect(source).not.toContain(":undefined");

    const executeHttpMatch = source.match(/async executeHttp\([\s\S]*?\n {2}},\n/);
    expect(executeHttpMatch).not.toBeNull();
    const executeHttpBody = executeHttpMatch?.[0] ?? "";

    const getGqlCallMatch = executeHttpBody.match(/await getGql\(context\.baseUrl\)\([^;]*\);/);
    expect(getGqlCallMatch).not.toBeNull();
    const getGqlCall = getGqlCallMatch?.[0] ?? "";

    expect(getGqlCall).toContain('"productSearch_Products"');
    // Required facet always included, unconditionally.
    expect(getGqlCall).toContain("`region:${payload.Region}`");
    // Optional facets are only included when their payload field is present.
    expect(getGqlCall).toContain("...(payload.Brand ? [`brand:${payload.Brand}`] : [])");
    expect(getGqlCall).toContain("...(payload.Len ? [`len:${payload.Len}`] : [])");
    // Segments are joined with the original delimiter, not frozen inline.
    expect(getGqlCall).toMatch(/\]\.join\("\|"\)/);
  });

  it("marks the optional facet fields .optional() in the payload schema while the required facet stays required", () => {
    const source = emitContractTs(buildOpts());

    const schemaMatch = source.match(/const CatalogExamplePayloadSchema = [\s\S]*?;\n/);
    expect(schemaMatch).not.toBeNull();
    const schemaBlock = schemaMatch?.[0] ?? "";

    expect(schemaBlock).toMatch(/Brand:\s*z\.string\(\)\.optional\(\)/);
    expect(schemaBlock).toMatch(/Len:\s*z\.string\(\)\.optional\(\)/);
    // Required facet's field is present but not suffixed with .optional().
    const regionFieldMatch = schemaBlock.match(/Region:\s*z\.string\(\)[^,\n]*/);
    expect(regionFieldMatch).not.toBeNull();
    expect(regionFieldMatch?.[0] ?? "").not.toContain(".optional()");
  });
});
