import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc" },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/search",
  auxFiles: [],
};

/**
 * Regression coverage for the fallback item: an executeHttp signature must not
 * declare an unused `payload` param (Biome noUnusedFunctionParameters) when
 * the assembled body never references it — mirrors the existing `context`
 * param guard one line above.
 */
describe("emitContractTs — executeHttp payload param declared vs. _payload guard", () => {
  it("declares `payload` when the assembled body references payload.", () => {
    const source = emitContractTs(BASE_OPTS);

    expect(source).toContain("query: payload.query");
    expect(source).toContain("payload: TestSitePayload,");
    expect(source).not.toContain("_payload: TestSitePayload,");
  });

  it("declares `_payload` when the assembled body never references payload.", () => {
    const source = emitContractTs({
      ...BASE_OPTS,
      multiStepBody: `    return { data: {} as unknown };`,
    });

    expect(source).not.toContain("payload.");
    expect(source).toContain("_payload: TestSitePayload,");
    expect(source).not.toContain(", payload: TestSitePayload,");
  });
});
