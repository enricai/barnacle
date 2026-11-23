import { describe, expect, it } from "vitest";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

const gen = (flowSteps: unknown[]) =>
  emitBrowserFlowTs({
    siteId: "t",
    pascal: "T",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    browserFlowOnly: true,
    flowSteps,
  } as never).code;

describe("verified tail only with a submit step", () => {
  it("no verified:true when last step is do-NOT-click-Pay", () => {
    const code = gen([
      "Click Continue",
      { step: "Click Pay (do NOT click Pay)", declareOnly: true },
    ]);
    expect(code).not.toContain("verified: true");
    expect(code).not.toContain("already verified the submit");
    expect(code).toContain("verified: false");
  });
  it("emits verified:true with an explicit submitStep", () => {
    const code = gen([
      "Click Continue",
      { step: "Click Pay (do NOT click Pay)", submitStep: true },
    ]);
    expect(code).toContain("verified: true");
  });
});
