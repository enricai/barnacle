import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/** Minimal opts that satisfy emitBrowserFlowTs for a submission flow, mirroring
 * recon-generate-frame-selector.test.ts's own disjoint fixture. */
const BASE_OPTS = {
  siteId: "recon-site-4",
  pascal: "ReconSite4",
  baseUrl: "https://careers.example.org",
  isSubmissionFlow: true,
};

describe("emitBrowserFlowTs — emailStep emission", () => {
  it("routes an emailStep:true step through allocatedInbox/emailStepConfig instead of the ordinary splice pipeline, with no hardcoded email link", () => {
    const { code } = emitBrowserFlowTs({
      ...BASE_OPTS,
      flowSteps: [
        "Fill in the application form",
        {
          step: "Click the verification link sent to your email",
          emailStep: true,
          emailStepConfig: { subjectContains: "Verify your email", extract: "link" },
        },
        { step: "Click the Submit button", submitStep: true },
      ],
    });

    expect(code).toContain(
      'import { testmailInboxFromAddress } from "@enricai/barnacle/testmail/client";'
    );
    expect(code).toContain("const allocatedInbox = testmailInboxFromAddress(payload.Email);");
    expect(code).toMatch(/runHealingFlow\(\{[\s\S]*allocatedInbox: allocatedInbox,[\s\S]*\}\)/);
    expect(code).toContain(
      '{ instruction: "Click the verification link sent to your email", optional: false, upload: false, submitStep: false, emailStep: true, emailStepConfig: {"subjectContains":"Verify your email","extract":"link"} },'
    );
    expect(code).not.toMatch(/https?:\/\/\S+\/verify/);
  });

  it("omits the testmail import, allocatedInbox const, and allocatedInbox dep entirely when no step declares emailStep — byte-identical to today's output", () => {
    const { code } = emitBrowserFlowTs({
      ...BASE_OPTS,
      flowSteps: [{ step: "Click the Submit button", submitStep: true }],
    });

    expect(code).not.toContain("testmailInboxFromAddress");
    expect(code).not.toContain("allocatedInbox");
    expect(code).not.toContain("emailStep");
  });

  it("bypasses the payload-field splice pipeline for an emailStep even when its instruction names an addressable field", () => {
    const { code, payloadFieldNames } = emitBrowserFlowTs({
      ...BASE_OPTS,
      flowSteps: [
        {
          step: "Enter the confirmation code from your email",
          emailStep: true,
          emailStepConfig: { extract: "code" },
        },
      ],
    });

    expect(payloadFieldNames.size).toBe(0);
    expect(code).not.toContain("payload.Confirmation");
  });
});
