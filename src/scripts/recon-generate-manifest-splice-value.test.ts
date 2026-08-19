import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { emitConfigManifest } from "@/scripts/recon-generate";

/** Recruiting-domain test vocabulary, exercised only by this unit test. */
const TEST_RECRUITING_VOCABULARY: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [],
  table: [[/\bfirst name\b/i, "FirstName"]],
};

type ManifestStep = string | { step: string };

function firstStepText(manifestStr: string): string {
  const manifest = JSON.parse(manifestStr) as { spec: { flow: { steps: ManifestStep[] } } };
  const step = manifest.spec.flow.steps[0];
  return typeof step === "string" ? step : step.step;
}

describe("emitConfigManifest — buildManifestInstruction splices the fill VALUE, never the selector", () => {
  const flowSteps = [
    {
      step: "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with 'Reginald'",
      payloadField: "FirstName",
    },
  ];

  it("splices {{ .request.FirstName }} at the trailing value, leaving the selector attribute byte-for-byte unchanged", () => {
    const manifestStr = emitConfigManifest({
      siteId: "acme-demo",
      displayName: "AcmeDemo",
      baseUrl: "https://apply.acme.example",
      flowSteps,
    });

    expect(firstStepText(manifestStr)).toBe(
      "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with {{ .request.FirstName }}"
    );
  });

  it("lands on the same site when the field is vocabulary-resolved rather than explicit", () => {
    const manifestStr = emitConfigManifest({
      siteId: "acme-demo",
      displayName: "AcmeDemo",
      baseUrl: "https://apply.acme.example",
      flowSteps: [
        {
          step: "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with 'Reginald'",
        },
      ],
      vocabulary: TEST_RECRUITING_VOCABULARY,
    });

    expect(firstStepText(manifestStr)).toBe(
      "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with {{ .request.FirstName }}"
    );
  });
});
