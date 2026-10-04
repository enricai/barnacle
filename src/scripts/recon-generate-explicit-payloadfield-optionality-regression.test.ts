import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/**
 * Regression test for `computeFlowPayloadFieldNames` registering an explicitly
 * declared `payloadField` as optional whenever the step that declared it also
 * carried `optional: true`. `optional` describes execution-skip risk — the
 * step may not run — not caller-omittable schema semantics: once a flow
 * author explicitly names a field, the caller must always supply it, so it
 * must never appear in `optionalPayloadFieldNames`. A sibling field resolved
 * purely via implicit vocabulary match (no explicit `payloadField`) keeps the
 * old behavior, proving the fix narrows to explicit declarations only.
 */

const VOCAB: ReconVocabulary = {
  subject: /(?!)/,
  exclusions: [],
  table: [[/\brewards level\b/i, "RewardsLevel"]],
};

describe("emitBrowserFlowTs — explicit payloadField declarations stay required regardless of step.optional", () => {
  it("excludes explicitly declared fields from optionalPayloadFieldNames while an implicit vocabulary match on an optional step still appears there", () => {
    const { payloadFieldNames, optionalPayloadFieldNames } = emitBrowserFlowTs({
      siteId: "test-catalog",
      pascal: "TestCatalog",
      baseUrl: "https://example.com",
      isSubmissionFlow: true,
      vocabulary: VOCAB,
      flowSteps: [
        {
          step: "navigate to the StoreRegion-specific catalog page",
          navigateTo: "https://example.com/#/catalog/store-region",
          payloadField: "StoreRegion",
          optional: true,
        },
        {
          step: "type 'Gold' into the Loyalty Tier field for the caller's account",
          payloadField: "LoyaltyTier",
          optional: true,
        },
        {
          step: "type 'Silver' into the Rewards Level field for the caller's account",
          optional: true,
        },
      ],
    });

    expect(payloadFieldNames.has("StoreRegion")).toBe(true);
    expect(payloadFieldNames.has("LoyaltyTier")).toBe(true);
    expect(payloadFieldNames.has("RewardsLevel")).toBe(true);

    expect(optionalPayloadFieldNames.has("StoreRegion")).toBe(false);
    expect(optionalPayloadFieldNames.has("LoyaltyTier")).toBe(false);
    expect(optionalPayloadFieldNames.has("RewardsLevel")).toBe(true);
  });
});
