import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/**
 * F4: the browser-flow file header must not unconditionally describe spliced
 * fields as "applicant"/PII data — a read-only plugin's generated header
 * shouldn't misdescribe filter facets as candidate PII.
 */
describe("emitBrowserFlowTs header splice comment is domain-neutral (F4)", () => {
  it("does not mention applicant/PII for a non-submission flow", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [],
      isSubmissionFlow: false,
    });

    expect(code).not.toContain("applicant");
    expect(code).not.toContain("PII");
  });

  it("still explains the splice mechanism for a submission flow, whether via domain-neutral wording or applicant/PII wording gated to this branch", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [],
      isSubmissionFlow: true,
    });

    const header = code.slice(0, code.indexOf("*/") + 2);
    expect(header).toContain("payload.<field>");
    expect(header).not.toContain("applicant");
    expect(header).not.toContain("PII");
  });
});
