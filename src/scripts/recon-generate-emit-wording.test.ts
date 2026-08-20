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

describe("emitBrowserFlowTs SPA-hydration-wait comment (F3)", () => {
  it("uses vendor-neutral wording instead of hardcoding Cloudflare", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [],
      isSubmissionFlow: false,
    });

    expect(code).not.toContain("Cloudflare");
    expect(code).toContain("bot-managed/CDN-fronted");
  });
});

describe("emitBrowserFlowTs browser-fallback schema (F5a)", () => {
  it("does not ship an actionable TODO in the extract schema for a non-submission flow", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [],
      isSubmissionFlow: false,
    });

    const schemaBlock = code.slice(
      code.indexOf("SomeSiteBrowserSchema = z.object({"),
      code.indexOf("});", code.indexOf("SomeSiteBrowserSchema = z.object({"))
    );

    expect(schemaBlock).not.toContain("TODO");
  });
});

describe("emitIndexTs registration guidance (FAILURE 6)", () => {
  it("directs the operator to BARNACLE_PLUGINS, not a core-file edit", () => {
    const code = emitIndexTs({ siteId: "some-site", pascal: "SomeSite" });

    expect(code).toContain("BARNACLE_PLUGINS");
    expect(code).not.toContain("src/plugins/loader.ts");
  });
});

describe("emitBrowserFlowTs header splice wording (F4)", () => {
  it("describes the payload splice domain-neutrally for a non-submission flow", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [],
      isSubmissionFlow: false,
    });

    expect(code).not.toContain("applicant");
    expect(code).not.toContain("PII");
    expect(code).toContain("the caller's real value");
  });

  it("does not unconditionally claim applicant-specific semantics for a submission flow", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [],
      isSubmissionFlow: true,
    });

    expect(code).not.toContain("applicant");
    expect(code).not.toContain("PII");
    expect(code).toContain("the caller's real value");
  });
});

/**
 * F2: the "multipart is required whenever" explainer comment must only be
 * emitted alongside the `multipart: true` field it explains, gated on the
 * same `payloadNeedsMultipart || inputBody` condition — not unconditionally.
 */
describe("emitContractTs — multipart explainer comment gate", () => {
  const baseOpts = {
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://api.example.com",
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: { saved: true },
    gql: false,
    gqlQuery: null,
    endpointPath: "/apply/create",
    auxFiles: [],
    multiStepBody: undefined,
    omitExecuteHttp: true,
  };

  it("omits the explainer comment when no multipart field is emitted", () => {
    const source = emitContractTs({
      ...baseOpts,
      hasMultipartStep: false,
      inputBody: undefined,
    });

    expect(source).not.toContain("multipart is required whenever");
    expect(source).not.toContain("multipart: true,");
  });

  it("includes the explainer comment alongside multipart: true when the flow uploads a file", () => {
    const source = emitContractTs({
      ...baseOpts,
      hasMultipartStep: true,
      inputBody: { FirstName: "Reginald" },
    });

    expect(source).toContain("multipart is required whenever");
    expect(source).toContain("multipart: true,");
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
