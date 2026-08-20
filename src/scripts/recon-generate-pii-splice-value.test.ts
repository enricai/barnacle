import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/**
 * Locks the splice-site fix for the emitted TS browser flow: a step whose
 * instruction carries a quoted selector attribute (e.g.
 * `data-automation-id='legalName--firstName'`) BEFORE the quoted fill value
 * must splice `${payload.<field>}` into the VALUE, never the selector — the
 * regex previously matched the FIRST quoted span in the whole instruction,
 * which is the selector in every wizard-ATS shape.
 */

const VOCAB: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [],
  table: [
    [/\bfirst name\b/i, "FirstName"],
    [/\baddress line 1\b/i, "AddressLine1"],
    [/\bstate\b/i, "State"],
    [/\bphone device type\b/i, "PhoneDeviceType"],
  ],
};

/**
 * The generated file's boilerplate (an extract query, buildRephraseModel,
 * etc.) references `payload` too, so assertions must scope to the emitted
 * FLOW_STEPS array literal rather than the whole file's `code`.
 */
function flowStepsBlock(code: string): string {
  const match = /const FLOW_STEPS: HealingFlowStep\[\] = \[([\s\S]*?)\n {2}\];/.exec(code);
  if (!match) throw new Error("FLOW_STEPS block not found in emitted code");
  return match[1]!;
}

function emitStep(step: string, vocabulary: ReconVocabulary = VOCAB): string {
  const { code } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    flowSteps: [step],
    isSubmissionFlow: false,
    vocabulary,
  });
  return flowStepsBlock(code);
}

describe("emitBrowserFlowTs — splice site targets the fill VALUE, not a selector or label", () => {
  it("splices the value in a fill step whose selector attribute precedes the quoted value", () => {
    const code = emitStep(
      "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with 'Reginald'"
    );

    expect(code).toContain("data-automation-id='legalName--firstName'");
    expect(code).not.toContain(`data-automation-id='$${"{payload.FirstName}"}'`);
    expect(code).toContain(`$${"{payload.FirstName}"}`);
    expect(code).not.toContain("'Reginald'");
  });

  it("splices AddressLine1 into the value only, leaving the selector attribute verbatim", () => {
    const code = emitStep(
      "Fill in the Address Line 1 field (data-automation-id='addressLine1') with '100 Test Street'"
    );

    expect(code).toContain("data-automation-id='addressLine1'");
    expect(code).not.toContain(`data-automation-id='$${"{payload.AddressLine1}"}'`);
    expect(code).toContain(`$${"{payload.AddressLine1}"}`);
    expect(code).not.toContain("'100 Test Street'");
  });

  it("does not splice into a screen name or a button label", () => {
    const emailToken = `'$${"{RECON_EMAIL}"}'`;
    const code = emitStep(
      `On the ATS ${emailToken} screen (step 1 of 8), click the 'Sign in with email' button`
    );

    expect(code).toContain("'Sign in with email'");
    expect(code).not.toContain(`$${"{payload."}`);
  });

  it("keeps the question label intact in a Select step, splicing the answer under an empty vocabulary", () => {
    const empty: ReconVocabulary = { subject: /(?!)/, exclusions: [], table: [] };
    const code = emitStep("In the 'RN state license' Select One dropdown, select 'No'", empty);

    expect(code).toContain("'RN state license'");
    expect(code).not.toContain(`$${"{payload."}`);
  });

  it("does not splice a button's own name even when the vocabulary genuinely label-matches it", () => {
    // Unlike the "does not splice into a screen name or a button label" case
    // above (whose default VOCAB has no Email row at all, so it can't tell
    // the namesAControl guard apart from a plain no-match), this vocabulary
    // includes a real e-mail row that DOES match the button's own name — the
    // guard must still keep the control name literal.
    const emailVocab: ReconVocabulary = {
      subject: /(?!)/,
      exclusions: [],
      table: [[/\b(e-?mail|email address)\b/i, "Email"]],
    };
    const code = emitStep("Click the 'Sign in with email' button", emailVocab);

    expect(code).toContain("'Sign in with email'");
    expect(code).not.toContain(`$${"{payload.Email}"}`);
  });

  it("does not splice a Yes/No answer even when the vocabulary label-matches the question", () => {
    // "RN state license" label-matches the State vocab row, but the ANSWER is a
    // Yes/No screening response, not the applicant's state — the operational-
    // answer guard must leave it literal regardless of the label match.
    const stateVocab: ReconVocabulary = {
      subject: /(?!)/,
      exclusions: [],
      table: [[/\bstate\b/i, "State"]],
    };
    const code = emitStep("In the 'RN state license' Select One dropdown, select 'No'", stateVocab);

    expect(code).toContain("'RN state license'");
    expect(code).toContain("'No'");
    expect(code).not.toContain(`$${"{payload."}`);
  });

  it("splices a Select step's answer when it equals the field's known value", () => {
    // A real STATE dropdown: the answer is the applicant's own datum, so it
    // still splices once it is not an operational Yes/No/enum literal.
    const stateVocab: ReconVocabulary = {
      subject: /(?!)/,
      exclusions: [],
      table: [[/\bstate\b/i, "State"]],
    };
    const code = emitStep(
      "In the 'State' dropdown, select 'Connecticut' for the state of residence",
      stateVocab
    );

    expect(code).toContain(`$${"{payload.State}"}`);
    expect(code).not.toContain("'Connecticut'");
  });
});
