import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs, emitContractTs, emitIndexTs } from "@/scripts/recon-generate";

const CONTRACT_BASE_OPTS = {
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

/**
 * Wording regressions from the a flowless recon capture:
 * - FAILURE 4: the empty-`FLOW_STEPS` stub pointed at a `recon-flow.json` this tool
 *   never writes.
 * - FAILURE 6: the emitted index.ts (correctly) says no core edits are required,
 *   which the completion log contradicted. These lock the generated-file side.
 */

describe("emitBrowserFlowTs empty-steps TODO (FAILURE 4)", () => {
  it("does not point the operator at a recon-flow.json the generator never writes", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [],
      isSubmissionFlow: false,
    });

    expect(code).not.toContain("recon-flow.json");
    expect(code).toContain("Re-run recon-browser");
  });
});

describe("emitIndexTs registration guidance (FAILURE 6)", () => {
  it("directs the operator to BARNACLE_PLUGINS, not a core-file edit", () => {
    const code = emitIndexTs({ siteId: "some-site", pascal: "SomeSite" });

    expect(code).toContain("BARNACLE_PLUGINS");
    expect(code).not.toContain("src/plugins/loader.ts");
  });
});

describe("emitContractTs rate-limit comment provenance", () => {
  it("emits a DEFAULT comment, not a probe claim, when no rate-limit probe ran", () => {
    const source = emitContractTs({ ...CONTRACT_BASE_OPTS, hasRateLimitProbeData: false });

    expect(source).toContain("DEFAULT (no rate-limit probe data; run recon:http).");
    expect(source).not.toContain("from recon rate-limit probe");
  });

  it("emits the probe-provenance comment when a real safeRps measurement was captured", () => {
    const source = emitContractTs({ ...CONTRACT_BASE_OPTS, hasRateLimitProbeData: true });

    expect(source).toContain("from recon rate-limit probe");
    expect(source).not.toContain("DEFAULT (no rate-limit probe data");
  });
});
