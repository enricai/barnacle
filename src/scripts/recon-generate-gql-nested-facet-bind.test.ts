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
  gqlQuery: "query catalogSearch_Products($input: SearchInput) { products { id } }",
  endpointPath: "/graphql",
  gqlOperationName: "catalogSearch_Products",
  auxFiles: [],
};

describe("emitContractTs — nested GraphQL facet threading", () => {
  it("binds a nested key matching a payload field to its payload accessor", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlVariables: { input: { author: "Doe", page: 1 } },
      payloadFieldNames: new Set(["author"]),
    });

    expect(source).toContain("author: payload.author");
    expect(source).not.toContain('"Doe"');
  });

  it("splices a nested packed key:value string into payload accessors", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlVariables: { input: { filters: "category:Fiction|format:Hardcover" } },
      payloadFieldNames: new Set(["category", "format"]),
    });

    expect(source).toContain(
      `filters: \`category:$${"{payload.category}"}|format:$${"{payload.format}"}\``
    );
    expect(source).not.toContain('"category:Fiction|format:Hardcover"');
  });

  it("splices a packed string inside an array nested under an object variable", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      gqlVariables: { input: { terms: ["category:Fiction"] } },
      payloadFieldNames: new Set(["category"]),
    });

    expect(source).toContain(`$${"{payload.category}"}`);
    expect(source).not.toContain('"category:Fiction"');
  });
});
