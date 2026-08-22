import { describe, expect, it } from "vitest";

import { emitContractTs } from "@/scripts/recon-generate";

const TRIM_COMMENT = "trim UI-only fields before shipping";

/** Minimal opts that satisfy the emitter for a non-multipart GraphQL plugin. */
const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: {
    data: {
      widget: {
        id: "abc",
        highlights: [{ backgroundColor: "#fff", __typename: "Highlight" }],
        __typename: "Widget",
      },
    },
  },
  gql: true,
  gqlQuery: "{ widget { id highlights { backgroundColor } } }",
  endpointPath: "/graphql",
  auxFiles: [],
  multiStepBody: `    return { data: {} as unknown };`,
};

describe("emitContractTs — GraphQL query-constant comment never ships as an unaddressed no-op", () => {
  const source = emitContractTs(BASE_OPTS);

  it("does not emit the literal 'trim UI-only fields before shipping' advice", () => {
    expect(source).not.toContain(TRIM_COMMENT);
  });

  it("if the advice comment is ever reintroduced, the adjacent ResponseSchema must be provably loose", () => {
    if (!source.includes(TRIM_COMMENT)) {
      return;
    }
    expect(source).not.toContain("__typename");
    const schemaMatch = source.match(/ResponseSchema = ([\s\S]+?);\n/);
    expect(schemaMatch).not.toBeNull();
    const schemaText = schemaMatch?.[1] ?? "";
    const objectOpens = schemaText.match(/z\.object\(\{/g) ?? [];
    const looseCloses = schemaText.match(/\}\)\.loose\(\)/g) ?? [];
    expect(objectOpens.length).toBeGreaterThan(0);
    expect(looseCloses.length).toBe(objectOpens.length);
  });
});
