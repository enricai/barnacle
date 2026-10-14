import { describe, expect, it } from "vitest";

import type { ReconVocabulary } from "@/recon/vocabulary";
import { buildKnownFieldValues, emitBrowserFlowTs } from "@/scripts/recon-generate";

const ENV = {} as NodeJS.ProcessEnv;

// Inline vocabulary: the Country Phone Code case needs only the exclusion gate
// (resolveStepPayloadField); pickValueSpan itself needs no engine change.
const VOCABULARY: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [/country\s+phone\s+code/i],
  table: [
    [/\bcity\b/i, "City"],
    [/\b(state|province)\b/i, "State"],
    [/\bcountry\b/i, "Country"],
  ],
};

function emit(step: string): string {
  return emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: false,
    flowSteps: [step],
    vocabulary: VOCABULARY,
  }).code;
}

describe("pickValueSpan — select verb position", () => {
  it("splices the answer after a mid-sentence select verb and leaves the label literal", () => {
    const step =
      "In the 'State' prompt selector, select 'Texas' and confirm the 'State' field now shows Texas";
    const code = emit(step);
    expect(code).toContain("payload.State");
    expect(code).toContain("'State' prompt selector");
    expect(code).not.toContain("'Texas'");
  });

  it("still splices the answer when the select verb leads", () => {
    const code = emit("Select 'TX' in the 'State' prompt selector of the address section");
    expect(code).toContain("payload.State");
    expect(code).not.toContain("'TX'");
    expect(code).toContain("'State' prompt selector");
  });

  it("still splices the last span for a fill step", () => {
    const code = emit("Fill in the City field with 'Dallas'");
    expect(code).toContain("payload.City");
    expect(code).not.toContain("Dallas");
  });

  it("agrees with buildKnownFieldValues on which span is the value", () => {
    const known = buildKnownFieldValues(["Fill in the State field with 'Texas'"], VOCABULARY, ENV);
    expect(known.get("State")).toBe("Texas");
    const code = emit("In the 'State' prompt selector, select 'Texas' and confirm");
    expect(code).toContain("payload.State");
  });
});

describe("pickValueSpan — Country Phone Code exclusion", () => {
  it("keeps a Country Phone Code select literal", () => {
    const code = emit("Select 'United States (+1)' in the 'Country Phone Code' selector");
    expect(code).toContain("United States (+1)");
    expect(code).not.toContain("payload.Country");
  });

  it("still splices a plain Country select", () => {
    const code = emit("Select 'United States' in the 'Country' selector");
    expect(code).toContain("payload.Country");
  });
});
