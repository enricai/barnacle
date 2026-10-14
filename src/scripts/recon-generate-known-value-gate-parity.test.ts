import { describe, expect, it } from "vitest";

import type { ReconVocabulary } from "@/recon/vocabulary";
import {
  buildKnownFieldValues,
  emitBrowserFlowTs,
  harvestPersonaBindings,
} from "@/scripts/recon-generate";

const VOCABULARY: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [/\bemployer\b/i],
  table: [[/\bfirst name\b/i, "FirstName"]],
};

const ENV = {} as NodeJS.ProcessEnv;
const OPTED_OUT = "Fill in the Job Title field in Work Experience 1 with 'Registered Nurse'";
const EXCLUDED = "Fill in the Employer Name field with 'Acme Hospital'";
const DERIVED = "Fill in the Job Title field with 'Registered Nurse'";

function emit(flowSteps: Parameters<typeof emitBrowserFlowTs>[0]["flowSteps"]): string {
  return emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: false,
    flowSteps,
    vocabulary: VOCABULARY,
  }).code;
}

describe("known-value gate parity with harvestPersonaBindings", () => {
  it("records no known value for a payloadFieldNone step", () => {
    const steps = [{ step: OPTED_OUT, payloadFieldNone: true }];
    expect([...buildKnownFieldValues(steps, VOCABULARY, ENV).values()]).not.toContain(
      "Registered Nurse"
    );
  });

  it("emits an opted-out step literally without tripping the leak guard", () => {
    const code = emit([{ step: OPTED_OUT, payloadFieldNone: true }]);
    expect(code).toContain("Registered Nurse");
  });

  it("records no known value for a vocabulary-excluded step and emits it literally", () => {
    expect(buildKnownFieldValues([EXCLUDED], VOCABULARY, ENV).size).toBe(0);
    expect(emit([EXCLUDED])).toContain("Acme Hospital");
  });

  it("still derives the label field for a non-opted-out fill step", () => {
    const known = buildKnownFieldValues([DERIVED], VOCABULARY, ENV);
    expect([...known.values()]).toEqual(["Registered Nurse"]);
  });

  it("agrees with harvestPersonaBindings on which steps carry a value", () => {
    const steps = [
      { step: OPTED_OUT, payloadFieldNone: true },
      EXCLUDED,
      DERIVED,
      "Fill in the First Name field with 'Reginald'",
    ];
    const known = new Set(buildKnownFieldValues(steps, VOCABULARY, ENV).values());
    const bound = new Set(harvestPersonaBindings(steps, VOCABULARY, ENV).keys());
    expect(known).toEqual(bound);
  });
});
