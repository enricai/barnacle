import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: true,
  gqlQuery: "query catalogSearch_Products($filters: String) { products { id } }",
  endpointPath: "/graphql",
  gqlOperationName: "catalogSearch_Products",
  auxFiles: [],
};

describe("emitContractTs — GraphQL string-facet correlation", () => {
  it("splices every correlated facet in a delimited filters-string into its own payload accessor", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlVariables: { filters: "category:Fiction|format:Hardcover" },
      payloadFieldNames: new Set(["category", "format"]),
    });

    expect(source).toContain(
      `filters: \`category:$${"{payload.category}"}|format:$${"{payload.format}"}\``
    );
    expect(source).not.toContain('"category:Fiction|format:Hardcover"');
  });

  it("splices only the facet that correlates, leaving the other facet's literal piece untouched", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlVariables: { filters: "category:Fiction|format:Hardcover" },
      payloadFieldNames: new Set(["category"]),
    });

    expect(source).toContain(`filters: \`category:$${"{payload.category}"}|format:Hardcover\``);
    expect(source).not.toContain('"category:Fiction|format:Hardcover"');
  });

  it("matches facet keys case-insensitively, mirroring top-level-key correlation", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlVariables: { filters: "Category:Fiction|Format:Hardcover" },
      payloadFieldNames: new Set(["category", "format"]),
    });

    expect(source).toContain(
      `filters: \`Category:$${"{payload.category}"}|Format:$${"{payload.format}"}\``
    );
    expect(source).not.toContain('"Category:Fiction|Format:Hardcover"');
  });
});
