import { describe, expect, it } from "vitest";

import { emitContractTs } from "@/scripts/recon-generate";

const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 200,
  safeRps: 5,
  responseBody: { id: "abc", active: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/search",
  auxFiles: [],
};

describe("emitContractTs — rate-limit ceiling comment provenance", () => {
  it("claims probe provenance when safeRps was derived from a real recon rate-limit probe", () => {
    const source = emitContractTs({ ...BASE_OPTS, hasRateLimitProbeData: true });
    expect(source).toContain("from recon rate-limit probe");
  });

  it("emits a DEFAULT/no-probe-data comment, not the probe-provenance wording, when no probe data was found", () => {
    const source = emitContractTs({ ...BASE_OPTS, hasRateLimitProbeData: false });
    expect(source).toContain("DEFAULT");
    expect(source).not.toContain("from recon rate-limit probe");
  });
});
