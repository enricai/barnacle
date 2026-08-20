import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs } from "@/scripts/recon-generate";

// The stub field itself (`extraction: z.string()`) is a deliberate minimal
// shape, not the defect — only the "TODO: define the fields you need"
// comment shipped as reviewable-looking scratch work (F5a).
describe("emitBrowserFlowTs — browser-fallback extract schema ships without a TODO stub (F5a)", () => {
  it("non-submission flow: no TODO in the generated code", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [{ step: "Click search" }],
      isSubmissionFlow: false,
    });

    const schemaBlock = code.slice(
      code.indexOf("SomeSiteBrowserSchema = z.object({"),
      code.indexOf("});", code.indexOf("SomeSiteBrowserSchema = z.object({"))
    );

    expect(schemaBlock).not.toContain("TODO");
  });

  it("submission flow: unaffected, still emits verified: z.boolean()", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "some-site",
      pascal: "SomeSite",
      baseUrl: "https://example.com",
      flowSteps: [{ step: "Click submit", submitStep: true }],
      isSubmissionFlow: true,
    });

    expect(code).toContain("verified: z.boolean()");
  });
});
