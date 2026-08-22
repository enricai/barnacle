import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Regression coverage for bugfix-001: a merged extend field whose name
 * case-insensitively matches an `unpopulatedDeclaredVariables` entry must be
 * emitted `.optional()` in the generated bodySchema, since it has no wiring
 * target in executeHttp. Siblings not in that list stay required.
 */
describe("emitContractTs — unpopulated declared GraphQL variables become optional payload fields", () => {
  it("emits .optional() for a payloadFieldNames entry matching unpopulatedDeclaredVariables, leaving other fields required", () => {
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
        "query productSearch_Products($filters: String, $sort: String) { products(filters: $filters, sort: $sort) { id name } }",
      endpointPath: "/graphql",
      gqlOperationName: "productSearch_Products",
      gqlVariables: { filters: "category:widgets", sort: "" },
      payloadFieldNames: new Set(["Category", "Sort"]),
      unpopulatedDeclaredVariables: ["Sort"],
      auxFiles: [],
    });

    expect(source).toMatch(/Sort: z\.string\(\)\.optional\(\),/);
    expect(source).toMatch(/Category: z\.string\(\),/);
    expect(source).not.toMatch(/Category: z\.string\(\)\.optional\(\),/);
  });

  it("keeps every field required when unpopulatedDeclaredVariables is empty (default)", () => {
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
      gqlVariables: { filters: "category:widgets" },
      payloadFieldNames: new Set(["Category"]),
      auxFiles: [],
    });

    expect(source).toMatch(/Category: z\.string\(\),/);
    expect(source).not.toContain(".optional()");
  });

  it("does not downgrade the base Email/ClickUrl/Answers contract fields on a submission flow, even when a GraphQL variable shares the name", () => {
    const source = emitContractTs({
      siteId: "submit-example",
      pascal: "SubmitExample",
      baseUrl: "https://submit-example.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { ok: true },
      inputBody: { email: "" },
      gql: true,
      gqlQuery: "mutation submit($email: String) { submit(email: $email) { ok } }",
      endpointPath: "/graphql",
      gqlOperationName: "submit",
      gqlVariables: { email: "" },
      payloadFieldNames: new Set(),
      unpopulatedDeclaredVariables: ["email"],
      auxFiles: [],
    });

    expect(source).toMatch(/Email: z\.email\(\),/);
    expect(source).not.toMatch(/Email: z\.email\(\)\.optional\(\),/);
  });
});
