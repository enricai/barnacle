import { describe, expect, it } from "vitest";

import {
  assertRequiredUrlFieldsReferenced,
  emitBrowserFlowTs,
  emitContractTs,
} from "@/scripts/recon-generate";

/**
 * Regression coverage for
 * docs/recon-generate-browser-flow-entry-url-pii-and-unverified-submit.md
 * defect 1: a generated submission flow must enter on the payload's own
 * apply/click URL, not the plugin's static baseUrl.
 */
describe("recon-generate — browser-flow entry URL", () => {
  const submissionOpts = {
    siteId: "recon-site-9",
    pascal: "ReconSite9",
    baseUrl: "https://careers.example.org",
    isSubmissionFlow: true,
    flowSteps: ["Click the Apply button"],
  };

  it("a submission flow's run<Pascal>BrowserFlow declares entryUrl (not baseUrl) and calls page.goto(entryUrl, ...)", () => {
    const { code } = emitBrowserFlowTs(submissionOpts);

    expect(code).toMatch(
      /export async function runReconSite9BrowserFlow\(\s*stagehand: Stagehand,\s*entryUrl: string,/
    );
    expect(code).toContain('page.goto(entryUrl, { waitUntil: "networkidle" })');
    expect(code).not.toMatch(
      /runReconSite9BrowserFlow\(\s*stagehand: Stagehand,\s*baseUrl: string,/
    );
    expect(code).not.toContain("page.goto(baseUrl,");
  });

  it("a non-submission (query) flow keeps baseUrl untouched", () => {
    const { code } = emitBrowserFlowTs({ ...submissionOpts, isSubmissionFlow: false });

    expect(code).toContain(
      "runReconSite9BrowserFlow(\n  stagehand: Stagehand,\n  baseUrl: string,"
    );
    expect(code).toContain('page.goto(baseUrl, { waitUntil: "networkidle" })');
    expect(code).not.toContain("entryUrl");
  });

  const contractOpts = {
    siteId: "recon-site-9",
    pascal: "ReconSite9",
    baseUrl: "https://careers.example.org",
    baseHeaders: {},
    minTime: 100,
    safeRps: 10,
    responseBody: { ok: true },
    gql: false,
    gqlQuery: null,
    endpointPath: "/apply",
    auxFiles: [],
    inputBody: { FirstName: "Reginald" },
  };

  it("emitContractTs's execute() call site passes payload.ClickUrl for a submission flow, not context.baseUrl", () => {
    const source = emitContractTs(contractOpts);

    expect(source).toContain(
      "await runReconSite9BrowserFlow(session.stagehand, payload.ClickUrl, payload)"
    );
    expect(source).not.toContain(
      "await runReconSite9BrowserFlow(session.stagehand, context.baseUrl, payload)"
    );
  });

  it("a non-submission (query) flow's execute() call site is unaffected — still passes context.baseUrl", () => {
    const { inputBody: _inputBody, ...queryOpts } = contractOpts;
    const source = emitContractTs(queryOpts);

    expect(source).toContain(
      "await runReconSite9BrowserFlow(session.stagehand, context.baseUrl, payload)"
    );
  });

  describe("assertRequiredUrlFieldsReferenced", () => {
    it("throws when a required *Url payload field is declared but never referenced by the emitted browser flow", () => {
      const contractCode = "ClickUrl: z.string().min(1),";
      const browserFlowCode = 'await page.goto(entryUrl, { waitUntil: "networkidle" });';

      expect(() => assertRequiredUrlFieldsReferenced(contractCode, browserFlowCode)).toThrow(
        /ClickUrl/
      );
    });

    it("does not throw once the flow references payload.ClickUrl somewhere", () => {
      const contractCode = "ClickUrl: z.string().min(1),";
      const browserFlowCode =
        'const url = payload.ClickUrl;\nawait page.goto(url, { waitUntil: "networkidle" });';

      expect(() => assertRequiredUrlFieldsReferenced(contractCode, browserFlowCode)).not.toThrow();
    });

    it("ignores optional URL fields — only required ones must be referenced", () => {
      const contractCode = "RedirectUrl: z.string().optional(),";
      const browserFlowCode = 'await page.goto(baseUrl, { waitUntil: "networkidle" });';

      expect(() => assertRequiredUrlFieldsReferenced(contractCode, browserFlowCode)).not.toThrow();
    });

    it("generalizes past ClickUrl — any required *Url field name is checked", () => {
      const contractCode = "ApplyUrl: z.string().min(1),";
      const browserFlowCode = 'await page.goto(baseUrl, { waitUntil: "networkidle" });';

      expect(() => assertRequiredUrlFieldsReferenced(contractCode, browserFlowCode)).toThrow(
        /ApplyUrl/
      );
    });

    it("integration: a real emitContractTs + emitBrowserFlowTs pair for a submission flow passes the guard", () => {
      const browserFlow = emitBrowserFlowTs(submissionOpts);
      const contractCode = emitContractTs({
        ...contractOpts,
        payloadFieldNames: browserFlow.payloadFieldNames,
      });

      expect(() => assertRequiredUrlFieldsReferenced(contractCode, browserFlow.code)).not.toThrow();
    });
  });
});
