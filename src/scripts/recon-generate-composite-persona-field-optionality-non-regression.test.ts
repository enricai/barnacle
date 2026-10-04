import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/**
 * Regression guard distinct from the payload-schema-optionality fix: a
 * composite-persona-derived field pair (resolveCompositePersonaFields) has
 * no author-declared payloadField to anchor an always-required override on,
 * so it must keep tracking step.optional exactly as before that fix rather
 * than being swept into the always-required override meant for explicit
 * payloadField declarations. The establishing steps carry the same
 * step.optional value as the composite step itself, so widest-wins cannot
 * mask an overcorrection that forces the composite registration to
 * required regardless of step.optional.
 */

const VOCAB: ReconVocabulary = {
  subject: /\b(the\s+)?(applicant|candidate)'?s\b/i,
  exclusions: [],
  table: [
    [/\bregion\b/i, "Region"],
    [/\btier\b/i, "Tier"],
  ],
};

describe("emitBrowserFlowTs — composite persona field optionality non-regression", () => {
  it("marks both composite-resolved fields optional when their step is optional", () => {
    const { optionalPayloadFieldNames } = emitBrowserFlowTs({
      siteId: "test-agency",
      pascal: "TestAgency",
      baseUrl: "https://example.com",
      isSubmissionFlow: true,
      vocabulary: VOCAB,
      flowSteps: [
        { step: "Fill in the Region field with 'Midwest'", optional: true },
        { step: "Fill in the Tier field with 'Gold'", optional: true },
        {
          step: "Confirm shipping details 'Midwest Gold' on the final review screen",
          optional: true,
        },
      ],
    });

    expect(optionalPayloadFieldNames.has("Region")).toBe(true);
    expect(optionalPayloadFieldNames.has("Tier")).toBe(true);
  });

  it("leaves both composite-resolved fields required when their step's optional is omitted", () => {
    const { optionalPayloadFieldNames } = emitBrowserFlowTs({
      siteId: "test-agency",
      pascal: "TestAgency",
      baseUrl: "https://example.com",
      isSubmissionFlow: true,
      vocabulary: VOCAB,
      flowSteps: [
        "Fill in the Region field with 'Midwest'",
        "Fill in the Tier field with 'Gold'",
        "Confirm shipping details 'Midwest Gold' on the final review screen",
      ],
    });

    expect(optionalPayloadFieldNames.has("Region")).toBe(false);
    expect(optionalPayloadFieldNames.has("Tier")).toBe(false);
  });
});
