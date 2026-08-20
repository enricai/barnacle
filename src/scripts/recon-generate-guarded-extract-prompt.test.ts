import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/**
 * Regression coverage for report section 2: the post-flow guardedExtract
 * call for a submission flow must never interpolate the applicant payload
 * (name, address, ResumeBase64) into the LLM prompt string.
 */
describe("recon-generate — guardedExtract prompt", () => {
  const submissionOpts = {
    siteId: "recon-site-9",
    pascal: "ReconSite9",
    baseUrl: "https://careers.example.org",
    isSubmissionFlow: true,
    flowSteps: ["Click the Apply button"],
  };

  it("a submission flow's guardedExtract prompt is payload-free and page-focused", () => {
    const { code } = emitBrowserFlowTs(submissionOpts);

    expect(code).not.toContain("JSON.stringify(payload)");
    expect(code).not.toContain("payload.Resume");
    expect(code).not.toContain("payload.ResumeBase64");
    expect(code).not.toMatch(/guardedExtract\(\s*stagehand,\s*`[^`]*\$\{payload\./);
    expect(code).toContain("confirmation");
    expect(code).toContain("?");
  });

  it("a non-submission (query) flow's prompt is unchanged", () => {
    const { code } = emitBrowserFlowTs({ ...submissionOpts, isSubmissionFlow: false });

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(code).toContain("`extract results matching query: ${payload.query}`");
  });
});
