import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/**
 * Composite regression for the full evidence table filed against a
 * generated browser flow: one emitBrowserFlowTs call carrying every
 * operational literal that must stay literal (button name, device-type
 * dropdown, two Yes/No screening answers) alongside every genuinely-personal
 * value that must splice (name, email, state, phone number), in the same
 * flow so a future change can't regress one guard while an isolated
 * single-mechanism test keeps passing.
 */

const VOCAB: ReconVocabulary = {
  subject: /\b(the\s+)?(applicant|candidate)'?s\b/i,
  exclusions: [],
  table: [
    [/\bfirst name\b/i, "FirstName"],
    [/\blast name\b/i, "LastName"],
    [/\bemail\b/i, "Email"],
    [/\bstate\b/i, "State"],
    [/\bphone\b/i, "MobilePhone"],
  ],
};

function flowStepsBlock(code: string): string {
  const match = /const FLOW_STEPS: HealingFlowStep\[\] = \[([\s\S]*?)\n {2}\];/.exec(code);
  if (!match) throw new Error("FLOW_STEPS block not found in emitted code");
  return match[1]!;
}

describe("emitBrowserFlowTs — composite evidence scenario: operational literals stay literal, personal data splices", () => {
  it("splices every personal field once and leaves every operational literal untouched, in a single flow", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "test-clinic",
      pascal: "TestClinic",
      baseUrl: "https://example.com",
      isSubmissionFlow: true,
      vocabulary: VOCAB,
      flowSteps: [
        "Click the 'Sign in with email' button",
        "Type 'Reginald' into the First Name field",
        "Type 'Watson' into the Last Name field",
        "Type 'reginald.watson@example.com' into the Email field",
        "In the 'State' dropdown, select 'Connecticut' for the applicant's state of residence",
        "Select 'Mobile' from the phone device type popup list",
        "Type '5125550000' into the Mobile Phone field",
        "Select 'No' for the previously excluded or debarred question",
        "Select 'Yes' for the actively licensed in this state question",
      ],
    });
    const block = flowStepsBlock(code);

    expect(block).toContain(`$${"{payload.FirstName}"}`);
    expect(block).toContain(`$${"{payload.LastName}"}`);
    expect(block).toContain(`$${"{payload.Email}"}`);
    expect(block).toContain(`$${"{payload.State}"}`);
    expect(block).toContain(`$${"{payload.MobilePhone}"}`);

    expect(block).toContain("'Sign in with email'");
    expect(block).toContain("'Mobile'");
    expect(block).toContain("'No'");
    expect(block).toContain("'Yes'");

    expect(block).not.toContain("'Reginald'");
    expect(block).not.toContain("'Watson'");
    expect(block).not.toContain("'reginald.watson@example.com'");
    expect(block).not.toContain("'Connecticut'");
    expect(block).not.toContain("'5125550000'");

    const spliceCount = (block.match(/\$\{payload\./g) ?? []).length;
    expect(spliceCount).toBe(5);
  });
});
