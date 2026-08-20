import { describe, expect, it } from "vitest";

import { emitContractTs } from "@/scripts/recon-generate";

/** Minimal opts that satisfy emitContractTs for a non-multipart plugin —
 * matches recon-generate.test.ts's BASE_OPTS. */
const BASE_OPTS = {
  siteId: "listings-fixture",
  pascal: "ListingsFixture",
  baseUrl: "https://api.example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { products: [] },
  gql: false,
  gqlQuery: null,
  endpointPath: "/listings-avail-api/available-products/",
  auxFiles: [],
};

const EXPLAINER_SNIPPET = "multipart is required whenever the flow itself uploads a file";

describe("emitContractTs — multipart explainer comment gated on multipart: true", () => {
  it("emits neither the explainer comment nor multipart: true for a plain read-only plugin", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      multiStepBody: "    return { data: {} as unknown };",
    });

    expect(contract).not.toContain(EXPLAINER_SNIPPET);
    expect(contract).not.toContain("multipart: true");
  });

  it("emits both the explainer comment and multipart: true when a submission flow's inputBody drives multipart", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      inputBody: {},
      multiStepBody: "    return { data: {} as unknown };",
    });

    expect(contract).toContain(EXPLAINER_SNIPPET);
    expect(contract).toContain("multipart: true");
  });

  it("emits both the explainer comment and multipart: true when hasMultipartStep is set", () => {
    const contract = emitContractTs({
      ...BASE_OPTS,
      multiStepBody: "    return { data: {} as unknown };",
      hasMultipartStep: true,
    });

    expect(contract).toContain(EXPLAINER_SNIPPET);
    expect(contract).toContain("multipart: true");
  });
});
