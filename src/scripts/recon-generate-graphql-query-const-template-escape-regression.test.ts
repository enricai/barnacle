import { describe, expect, it } from "vitest";

import { emitContractTs } from "@/scripts/recon-generate";

/** Matches BASE_OPTS in recon-generate-bind-literal.test.ts, kept separate
 * per that file's own fixture convention. */
const BASE_OPTS = {
  siteId: "test-site",
  pascal: "AcmeJobs",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  endpointPath: "/graphql",
  auxFiles: [],
};

describe("emitContractTs queryConst — backtick/${} escaping regression", () => {
  it("escapes a literal backtick in the resolved query text so the emitted QUERY stays a single valid template literal", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      gql: true,
      gqlQuery: "query { field(label: `weird`) }",
    });

    expect(contract).toContain("const ACMEJOBS_QUERY = `query { field(label: \\`weird\\`) }`;");
  });

  it("escapes a ${...} interpolation start in the resolved query text so it is not reinterpreted as a splice", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      gql: true,
      gqlQuery: "query { field(id: ${maliciousSplice}) }",
    });

    expect(contract).toContain(
      "const ACMEJOBS_QUERY = `query { field(id: \\${maliciousSplice}) }`;"
    );
  });
});
