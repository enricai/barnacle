import { describe, expect, it } from "vitest";

import { shouldSkipTechnique } from "@/scraper/flow-runner";

describe("scraper/flow-runner shouldSkipTechnique phantom-click escalation", () => {
  it("skips observe-act after a phantom click on attempt 1, stating the escalation reason", () => {
    const decision = shouldSkipTechnique({
      technique: "observe-act",
      priorAttempts: [{ technique: "act-string", triedSelectors: ["#submit"], errorMessage: null }],
      phantomClickAfterAttempt1: true,
    });

    expect(decision.skip).toBe(true);
    expect(decision.reason).toContain("phantom click");
    expect(decision.reason).toContain("deep submit-control locator");
  });

  it("skips observe-act-exclude after a phantom click on attempt 1, stating the escalation reason", () => {
    const decision = shouldSkipTechnique({
      technique: "observe-act-exclude",
      priorAttempts: [
        { technique: "act-string", triedSelectors: ["#submit"], errorMessage: null },
        { technique: "deep-submit-locator", triedSelectors: [], errorMessage: null },
      ],
      phantomClickAfterAttempt1: true,
    });

    expect(decision.skip).toBe(true);
    expect(decision.reason).toContain("phantom click");
  });

  it("skips structured-click after a phantom click on attempt 1, stating the escalation reason", () => {
    const decision = shouldSkipTechnique({
      technique: "structured-click",
      priorAttempts: [{ technique: "act-string", triedSelectors: ["#submit"], errorMessage: null }],
      phantomClickAfterAttempt1: true,
    });

    expect(decision.skip).toBe(true);
    expect(decision.reason).toContain("phantom click");
  });

  it("does not skip observe-act when attempt 1 was not a phantom click", () => {
    const decision = shouldSkipTechnique({
      technique: "observe-act",
      priorAttempts: [{ technique: "act-string", triedSelectors: ["#submit"], errorMessage: null }],
      phantomClickAfterAttempt1: false,
    });

    expect(decision.skip).toBe(false);
  });

  it("still skips structured-click when no prior attempt resolved an xpath (existing-behaviour control)", () => {
    const decision = shouldSkipTechnique({
      technique: "structured-click",
      priorAttempts: [{ technique: "act-string", triedSelectors: [], errorMessage: null }],
      phantomClickAfterAttempt1: false,
    });

    expect(decision.skip).toBe(true);
    expect(decision.reason).toContain("structured-click needs a prior xpath");
  });
});
