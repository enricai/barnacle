import { describe, expect, it } from "vitest";

import type { ReconVocabulary } from "@/recon/vocabulary";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/** Splice reference the emitter injects, e.g. `${payload.FirstName}`. */
function payloadRef(field: string): string {
  return `$${`{payload.${field}}`}`;
}

/** Mirrors the real-world vocabulary shape from the reported defect: a
 * phone-number row whose alternation also matches the bare word "mobile",
 * which a device-type dropdown answer ("Mobile") shares without meaning it. */
const TEST_VOCABULARY: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(applicant|contact)'?s\b/i,
  exclusions: [],
  table: [[/\b(mobile phone|phone number|mobile)\b/i, "MobilePhone"]],
};

describe("emitBrowserFlowTs — known-value guard survives full codegen", () => {
  const { code } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps: [
      "Type '5125550000' into the Mobile Phone field",
      "Select 'Mobile' from the device type dropdown",
    ],
    vocabulary: TEST_VOCABULARY,
  });

  it("splices the real phone number for the Fill step", () => {
    expect(code).toContain(payloadRef("MobilePhone"));
  });

  it("keeps the device-type dropdown answer as the literal 'Mobile', not a second splice", () => {
    expect(code).toContain("'Mobile'");
    expect(code.split(payloadRef("MobilePhone")).length - 1).toBe(1);
  });
});
