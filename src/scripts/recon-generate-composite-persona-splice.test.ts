import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/**
 * Locks that a step whose quoted value is a concatenation of two
 * already-established persona fields (e.g. a signature name built from
 * `${FirstName} ${LastName}`, in either order) is spliced from BOTH fields
 * rather than surviving as a fabricated-name literal, and that generation
 * fails loudly if any known persona constant is still detectable in the
 * final emitted code.
 */

const VOCAB: ReconVocabulary = {
  subject: /\b(the\s+)?(applicant|candidate)'?s\b/i,
  exclusions: [],
  table: [
    [/\bfirst name\b/i, "FirstName"],
    [/\blast name\b/i, "LastName"],
  ],
};

function flowStepsBlock(code: string): string {
  const match = /const FLOW_STEPS: HealingFlowStep\[\] = \[([\s\S]*?)\n {2}\];/.exec(code);
  if (!match) throw new Error("FLOW_STEPS block not found in emitted code");
  return match[1]!;
}

describe("emitBrowserFlowTs — composite persona value splice (FirstName + LastName)", () => {
  it("splices both payload accessors into a signature step whose value is FirstName + ' ' + LastName", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "test-agency",
      pascal: "TestAgency",
      baseUrl: "https://example.com",
      isSubmissionFlow: true,
      vocabulary: VOCAB,
      flowSteps: [
        "Type 'Reginald' into the First Name field",
        "Type 'Reconaldo' into the Last Name field",
        "Type 'Reginald Reconaldo' into the digital signature field for the self-identification form",
      ],
    });
    const block = flowStepsBlock(code);

    expect(block).toContain(`$${"{payload.FirstName}"}`);
    expect(block).toContain(`$${"{payload.LastName}"}`);
    expect(block).not.toContain("'Reginald Reconaldo'");
    expect(block).not.toMatch(/'Reginald'.*signature|signature.*'Reginald'/);
  });

  it("splices in the reverse order when the value is LastName + ' ' + FirstName", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "test-agency",
      pascal: "TestAgency",
      baseUrl: "https://example.com",
      isSubmissionFlow: true,
      vocabulary: VOCAB,
      flowSteps: [
        "Type 'Reginald' into the First Name field",
        "Type 'Reconaldo' into the Last Name field",
        "Type 'Reconaldo Reginald' into the digital signature field for the self-identification form",
      ],
    });
    const block = flowStepsBlock(code);

    expect(block).toContain(`\${payload.LastName} \${payload.FirstName}`);
    expect(block).not.toContain("'Reconaldo Reginald'");
  });

  it("throws when a known persona constant is left unspliced in the emitted code", () => {
    // payloadFieldNone opts the signature step out of splicing entirely, so
    // the composite path never runs for it — the literal 'Reginald Reconaldo'
    // survives to the final `code` string, and the safety-net scan must
    // catch it and fail generation loudly rather than shipping it.
    expect(() =>
      emitBrowserFlowTs({
        siteId: "test-agency",
        pascal: "TestAgency",
        baseUrl: "https://example.com",
        isSubmissionFlow: true,
        vocabulary: VOCAB,
        flowSteps: [
          "Type 'Reginald' into the First Name field",
          "Type 'Reconaldo' into the Last Name field",
          {
            step: "Type 'Reginald Reconaldo' into the digital signature field for the self-identification form",
            payloadFieldNone: true,
          },
        ],
      })
    ).toThrow(/persona constant/i);
  });
});
