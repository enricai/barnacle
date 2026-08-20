import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/**
 * Regression coverage: once a submission flow's submit step has verified
 * (runHealingFlow's submitStep gate), the trailing guardedExtract call that
 * pulls the confirmation page must never be able to fail the run — a throw
 * there must be caught, logged, and degraded to a not-confirmed result
 * instead of propagating out of run<Pascal>BrowserFlow and triggering a
 * duplicate re-dispatch. A non-submission (query) flow has nothing
 * already-committed to protect, so its guardedExtract call stays unwrapped.
 */
describe("recon-generate — post-submit guardedExtract guard", () => {
  const submissionOpts = {
    siteId: "recon-site-4",
    pascal: "ReconSite4",
    baseUrl: "https://careers.example.org",
    isSubmissionFlow: true,
    flowSteps: ["Click the First Name field and type John", "Click the Submit Application button"],
  };

  it("wraps the post-submit guardedExtract call in a try/catch for a submission flow", () => {
    const { code } = emitBrowserFlowTs(submissionOpts);
    const extractIndex = code.indexOf("guardedExtract(");
    const tryIndex = code.lastIndexOf("try {", extractIndex);

    expect(extractIndex).toBeGreaterThan(-1);
    expect(tryIndex).toBeGreaterThan(-1);
    expect(code.slice(tryIndex, extractIndex)).not.toContain("}");
  });

  it("logs via the module logger and returns a not-confirmed result in the catch branch", () => {
    const { code } = emitBrowserFlowTs(submissionOpts);

    expect(code).toContain("} catch (error) {");
    expect(code).toContain("logger.error(");
    expect(code).toContain("return { verified: false } as unknown as ReconSite4Response;");
  });

  it("does not let the guardedExtract rejection propagate past the catch — the success path stays inside the try", () => {
    const { code } = emitBrowserFlowTs(submissionOpts);
    const tryIndex = code.indexOf("try {");
    const catchIndex = code.indexOf("} catch (error) {");
    const successReturnIndex = code.indexOf("return { ...result, verified: true }");

    expect(tryIndex).toBeGreaterThan(-1);
    expect(catchIndex).toBeGreaterThan(tryIndex);
    expect(successReturnIndex).toBeGreaterThan(tryIndex);
    expect(successReturnIndex).toBeLessThan(catchIndex);
  });

  it("leaves a non-submission (query) flow's guardedExtract call unwrapped", () => {
    const { code } = emitBrowserFlowTs({ ...submissionOpts, isSubmissionFlow: false });

    expect(code).not.toContain("try {");
    expect(code).not.toContain("} catch (error) {");
    expect(code).toContain("const result = await guardedExtract(");
    expect(code).toContain("return result;");
    expect(code).not.toContain("as unknown as ReconSite4Response");
  });
});
