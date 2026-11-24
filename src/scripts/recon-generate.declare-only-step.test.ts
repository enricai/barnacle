import { describe, expect, it } from "vitest";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

describe("declare-only step through every literal branch", () => {
  it("honors submitStep on navigateTo, email and password branches", () => {
    const code = emitBrowserFlowTs({
      siteId: "t",
      pascal: "T",
      baseUrl: "https://example.com",
      isSubmissionFlow: false,
      flowSteps: [
        {
          step: "Go to pay",
          navigateTo: "https://example.com/pay",
          declareOnly: true,
          submitStep: true,
        },
        { step: "Read code", emailStep: true, declareOnly: true, submitStep: true },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal token in a flow step
        { step: "Type password ${RECON_PASSWORD}", declareOnly: true, submitStep: true },
      ],
    }).code;
    expect(code.match(/submitStep: true/g)?.length).toBe(3);
  });
});
