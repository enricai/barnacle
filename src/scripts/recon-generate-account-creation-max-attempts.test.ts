import { describe, expect, it } from "vitest";

import type { ReconVocabulary } from "@/recon/vocabulary";
import { emitBrowserFlowTs, emitContractTs } from "@/scripts/recon-generate";

/** Concatenation trick so Biome's noTemplateCurlyInString rule doesn't flag the literal. */
const RECON_PASSWORD_TOKEN = `$${"{RECON_PASSWORD}"}`;

const VOCABULARY: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [],
  table: [[/\bphone number\b/i, "Phone"]],
};

function browserFlow(flowSteps: string[]): ReturnType<typeof emitBrowserFlowTs> {
  return emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps,
    vocabulary: VOCABULARY,
  });
}

const CONTRACT_BASE = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://api.example.com",
  baseHeaders: {},
  minTime: 100,
  safeRps: 10,
  responseBody: {},
  gql: false,
  gqlQuery: null,
  endpointPath: "/apply",
  auxFiles: [],
  multiStepBody: undefined,
  isSubmissionFlow: true,
  inputBody: { vendorKey: "x" },
  payloadFieldNames: new Set(["FirstName"]),
};

describe("account-creation flows emit meta.maxAttempts: 1", () => {
  const withPassword = browserFlow([
    `Fill in the Password field (data-automation-id='password') with '${RECON_PASSWORD_TOKEN}'`,
  ]);
  const withoutPassword = browserFlow(["Click the Apply button"]);

  it("carries the password signal out of emitBrowserFlowTs only when the token is present", () => {
    expect(withPassword.usesThrowawayPassword).toBe(true);
    expect(withoutPassword.usesThrowawayPassword).toBe(false);
  });

  it("emits maxAttempts: 1 for the RECON_PASSWORD flow", () => {
    const source = emitContractTs({
      ...CONTRACT_BASE,
      omitExecuteHttp: true,
      createsAccount: withPassword.usesThrowawayPassword,
    });
    expect(source).toMatch(/maxAttempts: 1,/);
  });

  it("emits no maxAttempts for the same flow without the token", () => {
    const source = emitContractTs({
      ...CONTRACT_BASE,
      omitExecuteHttp: true,
      createsAccount: withoutPassword.usesThrowawayPassword,
    });
    expect(source).not.toContain("maxAttempts");
  });
});

describe("execute() context parameter reflects usage", () => {
  it("omits the context parameter and the hot-path-fallback comment for browser-only reading payload.ClickUrl", () => {
    const source = emitContractTs({ ...CONTRACT_BASE, omitExecuteHttp: true });
    expect(source).not.toContain("context: SitePluginContext");
    expect(source).not.toMatch(/import type \{[^}]*SitePluginContext/);
    expect(source).not.toContain("invoked only when hot path fails");
  });

  it("emits the hot-path-fallback comment when executeHttp exists", () => {
    const source = emitContractTs({ ...CONTRACT_BASE, omitExecuteHttp: false });
    expect(source).toContain("invoked only when hot path fails");
    expect(source).toMatch(/[^_]context: SitePluginContext/);
  });
});
