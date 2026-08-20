import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs, emitContractTs } from "@/scripts/recon-generate";

// G3 (docs/recon-generated-read-plugin-not-production-shaped.md): a
// non-submission browser fallback exists to rescue a failed hot-path call,
// so the schema it validates against must actually be able to produce the
// plugin's declared response shape — not `{ extraction: z.string() }` force
// -cast to `${pascal}Response` via `as unknown as`, which compiles without
// ever proving the runtime shape matches.
describe("emitBrowserFlowTs — non-submission browser-fallback response schema parity (G3)", () => {
  const contractOpts = {
    siteId: "catalog-fixture",
    pascal: "CatalogFixture",
    baseUrl: "https://example.com",
    baseHeaders: {},
    minTime: 200,
    safeRps: 5,
    responseBody: { products: [{ id: "1" }], total: 1, cursor: null },
    gql: false,
    gqlQuery: null,
    endpointPath: "/search",
    auxFiles: [],
  };

  it("emitContractTs exports the ResponseSchema by name for a multi-field response", () => {
    const contractCode = emitContractTs(contractOpts);

    expect(contractCode).toContain("export const CatalogFixtureResponseSchema =");
  });

  it("the emitted browser-flow module does not fall back to the extraction placeholder", () => {
    const { code } = emitBrowserFlowTs({
      siteId: contractOpts.siteId,
      pascal: contractOpts.pascal,
      baseUrl: contractOpts.baseUrl,
      flowSteps: [{ step: "Search the catalog" }],
      isSubmissionFlow: false,
    });

    expect(code).not.toContain("extraction: z.string()");
    expect(code).not.toContain("CatalogFixtureBrowserSchema");
  });

  it("the emitted browser-flow module imports and validates against the contract's shared ResponseSchema", () => {
    const { code } = emitBrowserFlowTs({
      siteId: contractOpts.siteId,
      pascal: contractOpts.pascal,
      baseUrl: contractOpts.baseUrl,
      flowSteps: [{ step: "Search the catalog" }],
      isSubmissionFlow: false,
    });

    expect(code).toContain(
      'import { type CatalogFixturePayload, type CatalogFixtureResponse, CatalogFixtureResponseSchema } from "@/sites/catalog-fixture/contract";'
    );
    expect(code).toContain("CatalogFixtureResponseSchema");
  });

  it("no cast bridges a schema that cannot actually produce the response shape", () => {
    const { code } = emitBrowserFlowTs({
      siteId: contractOpts.siteId,
      pascal: contractOpts.pascal,
      baseUrl: contractOpts.baseUrl,
      flowSteps: [{ step: "Search the catalog" }],
      isSubmissionFlow: false,
    });

    expect(code).not.toMatch(/as unknown as CatalogFixtureResponse/);
    expect(code).not.toMatch(/raw as CatalogFixtureResponse/);
    expect(code).toMatch(/return result;\s*\n}/);
  });

  it("submission flows are unaffected — still emit their own verified: z.boolean() schema", () => {
    const { code } = emitBrowserFlowTs({
      siteId: contractOpts.siteId,
      pascal: contractOpts.pascal,
      baseUrl: contractOpts.baseUrl,
      flowSteps: [{ step: "Submit the application" }],
      isSubmissionFlow: true,
    });

    expect(code).toContain("verified: z.boolean()");
    expect(code).toContain("CatalogFixtureBrowserSchema");
  });
});
